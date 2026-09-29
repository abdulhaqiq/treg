<script>
import { useDashboard } from '../state/context'
import ToolDrawer from '../components/ToolDrawer.vue'
export default { components: { ToolDrawer }, setup: useDashboard }
</script>

<template>

          <div class="tut-head">
            <div style="min-width:0">
              <button class="btn sm" style="margin-bottom:10px" @click="go('connections')">← Catalog</button>
              <div class="pl-row" style="gap:13px">
                <span class="plogo-tile" style="width:44px;height:44px;flex:0 0 44px;border-radius:11px">
                  <img class="plogo" style="width:27px;height:27px" :src="'/logos/'+mkProvider.service+'.svg'" alt="" aria-hidden="true" @error="$event.target.style.visibility='hidden'">
                </span>
                <div style="min-width:0">
                  <h1 style="margin:0">{{mkProvider.display_name}}</h1>
                  <p class="sub" style="margin:0">{{mkProvider.category}} · <span class="mono">{{mkProvider.base_url}}</span></p>
                </div>
              </div>
              <p class="sub" style="margin:12px 0 0;max-width:64ch">{{mkProvider.summary}}</p>
            </div>
            <div class="tut-actions">
              <a v-if="mkProvider.docs_url" class="btn sm" :href="mkProvider.docs_url" target="_blank" rel="noopener">API docs ↗</a>
              <button class="btn sm primary" :disabled="!mkProvider.configured || connBusy" @click="startConnect(mkProvider)">
                {{mkConns.length ? 'Add account' : 'Connect'}}
              </button>
            </div>
          </div>

          <div v-if="connErr" class="banner" style="margin-top:12px">{{connErr}}</div>
          <div v-for="c in mkNeedsCred" :key="'n'+c.id" class="banner" style="margin-top:12px">
            <div><b>{{c.name}}</b> is connected, but can't call the API on its own yet. {{c.extra_credential_note}}</div>
            <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
              <input class="bindinput" style="flex:1;min-width:220px" type="password"
                     :placeholder="c.extra_credential_label||'Second credential'"
                     v-model="extraCred[c.id]" @keyup.enter="saveExtraCred(c)"/>
              <button class="btn sm primary" :disabled="!extraCred[c.id] || extraBusy===c.id" @click="saveExtraCred(c)">
                {{extraBusy===c.id?'Saving…':'Save & finish setup'}}
              </button>
            </div>
          </div>
          <div v-if="!mkProvider.configured" class="banner" style="margin-top:12px">
            This server holds no client credentials for {{mkProvider.display_name}}, so the connect flow can't run here.
          </div>
          <div class="tgroup">
            <div class="tgh">Connected accounts <span class="tgh-n">{{mkConns.length}}</span>
              <span class="tgh-hint">each account gets its own tool name, so an agent can call a specific one</span></div>
            <div v-if="!mkConns.length" class="mk-empty">
              No accounts yet. Connecting takes you to {{mkProvider.display_name}} to approve — treg keeps the
              credential server-side and injects it on every call.
            </div>
            <div class="ttable-wrap" v-else><table class="ttable">
              <tr v-for="c in mkConns" :key="c.id">
                <td class="tn">
                  <!-- Which account this is; the tool name has its own column, so it is not repeated here. -->
                  <b :title="c.resource_ref">{{c.resource_name || c.name}}</b>
                  <span v-if="!c.resource_name" class="sub" style="display:block;font-size:11px;overflow-wrap:anywhere">
                    {{c.resource_ref || (c.supports_discovery ? 'no '+(c.resource_label||'account')+' chosen yet' : 'whole account')}}
                  </span>
                </td>
                <td class="th">
                  <!-- The tool name is the whole point of several accounts: it is what the agent types. -->
                  <span class="mono" :title="'treg call '+c.name">{{c.name}}</span>
                </td>
                <td class="ta">
                  <span v-if="c.health==='ok'" class="chip ok" title="A real upstream call succeeded with this credential">working</span>
                  <span v-else-if="c.health==='setup_required'" class="chip warn" :title="c.health_detail||'Account setup is required'">setup required</span>
                  <span v-else-if="c.health==='invalid'" class="chip warn" :title="c.last_error||'The last upstream call failed'">failing</span>
                  <span v-if="c.expiry_state==='expired'" class="chip warn" title="This credential has expired — reconnect">expired</span>
                  <span v-else-if="c.expiry_state==='expiring'" class="chip warn" :title="'Expires '+c.expires_at">expiring</span>
                  <span v-if="!c.refreshable" class="chip" title="treg cannot renew this one unattended — it must be reconnected by hand when it expires">manual renew</span>
                  <span v-if="c.extra_credential_note" class="chip warn" :title="c.extra_credential_note">needs a second credential</span>
                  <span v-for="cap in (c.capabilities||[])" :key="cap" class="chip ok">{{cap}}</span>
                </td>
                <td class="tx" @click.stop>
                  <button v-if="(c.missing_capabilities||[]).length" class="btn sm" @click="startConnect(mkProvider, c)"
                          :title="'Ask for '+c.missing_capabilities.join(', ')+' as well'">Add {{c.missing_capabilities.join(' + ')}}</button>
                  <button v-if="c.supports_discovery" class="btn sm" @click="openResources(c)"
                          :title="'Choose which '+(c.resource_label||'account')+' this connection uses'">Choose {{c.resource_label||'account'}}</button>
                  <button class="btn sm" @click="renameConnection(c)" title="Change the tool name an agent calls for this account">Rename</button>
                  <button class="btn sm" @click="reconnect(c)" title="Re-consent to refresh this account">Reconnect</button>
                  <button class="btn sm ico" :class="{danger:confirmDisc===c.id}" @click="disconnect(c)" :title="confirmDisc===c.id?'Click again to disconnect':'Disconnect'">✕</button>
                </td>
              </tr>
            </table></div>
          </div>

          <!-- Every tool this provider serves, by platform. A tool that is one of several providers
               doing the same thing links to that capability's comparison: from "what does my key do" to
               "who else does this, and how do they compare". -->
          <!-- The catalog-v2 control arm (state/catalogExperiment.js) keeps the page it had: platform
               chips in place of the tool list, whose links lead to comparison pages the ledger does not have. -->
          <div class="tgroup" v-if="!catalogLegacy && (mkToolShelves.length || (mkTools && mkTools.loading))">
            <div class="tgh">Tools <span class="tgh-n" v-if="mkToolCount">{{mkToolCount}}</span>
              <span class="tgh-hint">what an agent can call on {{mkProvider.display_name}}, by platform</span></div>
            <div v-if="mkTools && mkTools.loading && !mkToolShelves.length" class="mk-empty">Loading…</div>
            <div v-else-if="mkTools && mkTools.err" class="mk-empty">{{mkTools.err}}</div>
            <div v-for="p in mkToolShelves" :key="p.slug" class="pv-shelf" v-show="p.tools.length">
              <h3 class="pl-h"><a :href="platUrl(p.slug)" @click.prevent="openPlatform(p.slug)">{{p.label}}</a><i></i><em>{{p.tools.length}}</em></h3>
              <div class="pl-grid pl-grid-t">
                <div v-for="t in p.tools" :key="t.id" class="pl-card pl-tool" :class="{on:drawerTool===t.id}" role="button" tabindex="0"
                     @click="openTool(t.id)" @keydown.enter="openTool(t.id)">
                  <span class="pl-tool-b"><b>{{t.title}}</b>
                    <span class="pl-meta">{{toolPrice(t.e)}}<template v-if="t.compare"> · <a class="pv-cmp"
                      :href="platUrl(p.slug, t.compare.key)" @click.stop.prevent="openComparisonOn(p.slug, t.compare.key)" :title="t.compare.description">compare with {{t.compare.providers-1}} other{{t.compare.providers>2?'s':''}}</a></template></span></span>
                </div>
              </div>
            </div>
            <div v-if="mkPlumbCount" class="pv-shelf">
              <h3 class="pl-h pl-h-quiet"><span>Account and setup</span><i></i><em>{{mkPlumbCount}}</em></h3>
              <div class="pl-grid pl-grid-t">
                <template v-for="p in mkToolShelves" :key="'x'+p.slug">
                  <button v-for="t in p.plumbing" :key="t.id" class="pl-card pl-tool quiet" :class="{on:drawerTool===t.id}" @click="openTool(t.id)">
                    <span class="pl-tool-b"><b>{{t.title}}</b><span class="pl-meta">{{toolPrice(t.e)}}</span></span>
                  </button>
                </template>
              </div>
            </div>
          </div>
          <ToolDrawer v-if="drawerEp" />

          <div class="tgroup">
            <div class="tgh">Permissions <span class="tgh-hint">what {{mkProvider.display_name}} is asked to grant — hover a line for the exact scope</span></div>
            <div class="mk-perms">
              <div v-for="cap in (mkProvider.permission_capabilities||mkProvider.capabilities)" :key="cap" class="mk-perm">
                <div class="mk-perm-h">
                  <b>{{mkCapabilityLabel(cap)}}</b>
                  <span v-if="mkGranted.has(cap)" class="chip ok">granted</span>
                  <span v-else class="mk-quiet">not requested yet</span>
                </div>
                <p v-if="mkCapabilityIntro(cap)" class="mk-quiet" style="margin:8px 0 0">{{mkCapabilityIntro(cap)}}</p>
                <ul class="mk-perm-l">
                  <li v-for="d in mkCapabilityDetails(cap)" :key="d.scope||d.label" :title="d.scope||null">
                    <span class="mk-tick">✓</span>{{d.label}}
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div class="tgroup" v-if="catalogLegacy && mkPlatforms.length">
            <div class="tgh">Covered in the catalog <span class="tgh-n">{{mkPlatforms.length}}</span>
              <span class="tgh-hint">the platforms {{mkProvider.display_name}} serves - compare its endpoints with the other providers'</span></div>
            <div class="mk-filters" style="margin:0">
              <button v-for="pl in mkPlatforms" :key="pl.slug" class="mk-chip" @click="openPlatform(pl.slug)">{{pl.label}} <span>{{pl.endpoints}}</span></button>
            </div>
          </div>

</template>
