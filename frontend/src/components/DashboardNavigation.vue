<script>
import { useDashboard } from '../state/context'
import BrandMark from './BrandMark.vue'
// "More": the pages that are not daily work (openenrich and the hub in the app, the public arenas). Its menu sits on
// the window, since the nav row scrolls sideways and would cut a dropdown off.
export default {
  components: { BrandMark },
  setup: useDashboard,
  data: () => ({ moreOpen: false, moreAt: {} }),
  mounted() { window.addEventListener('click', this.closeMore) },
  unmounted() { window.removeEventListener('click', this.closeMore) },
  methods: {
    toggleMore(e) {
      const r = e.currentTarget.getBoundingClientRect()
      this.moreAt = { top: `${Math.round(r.bottom + 8)}px`, left: `${Math.round(Math.min(r.left, window.innerWidth - 248))}px` }
      this.moreOpen = !this.moreOpen
    },
    closeMore() { this.moreOpen = false },
  },
}
</script>

<template>
<header class="rd-top" >
      <div class="rd-identity">
        <a class="rd-brand brand" href="/" aria-label="treg home"><BrandMark/>treg</a>
        <div class="orgblock" v-if="authed">
          <div class="orgmain" :ref="el => setElement('orgmain', el)" @click="toggleOrgMenu" role="button" tabindex="0" @keydown.enter="toggleOrgMenu" @keydown.space.prevent="toggleOrgMenu" aria-haspopup="true" :aria-expanded="orgMenu" aria-label="Teams">
            <span class="role" :class="activeRole">{{activeRole}}</span>
            <b class="orgname">{{activeName}}</b>
            <span class="orgcaret">▾</span>
          </div>
          <div class="dropdown" v-if="orgMenu" :style="orgMenuStyle" @click.stop>
            <div class="grp" style="margin:4px 10px 6px">Your teams</div>
            <div class="orgrow" v-for="o in myOrgs" :key="o.slug" :class="{off:!connected(o.slug)}">
              <div class="orgrow-main">
                <div class="orgrow-name">{{o.name}}</div>
                <div class="orgrow-meta"><span class="role" :class="o.role">{{o.role}}</span><span v-if="isPersonal(o)" class="chip">personal</span><span v-if="o.demo" class="chip demo">demo</span></div>
              </div>
              <button class="orgrow-btn" @click.stop="orgSettings(o)" title="Team settings" aria-label="Team settings">⚙</button>
              <span v-if="o.slug===activeSlugNow" class="orgrow-active">✓ active</span>
              <button v-else-if="sessionMode || connected(o.slug)" class="orgrow-btn" @click.stop="switchTo(o)">Switch</button>
              <button v-else class="orgrow-btn" @click.stop="addOrg=true; orgMenu=false">Token</button>
            </div>
            <div class="orgrow-sep"></div>
            <button type="button" class="row" v-if="sessionMode" @click="newOrg=true; newOrgName=''; orgMenu=false"><span>＋ New team</span></button>
            <button type="button" class="row" v-if="sessionMode" @click="showJoin=true; joinCode=''; joinErr=''; orgMenu=false"><span>⤷ Join by code</span></button>
            <button type="button" class="row" v-if="!sessionMode" @click="addOrg=true; orgMenu=false"><span>＋ Add team with token</span></button>
          </div>
        </div>


      </div>
      <nav class="rd-navs" aria-label="Primary navigation"><button v-if="authed" class="rd-nav" :class="{active:view==='start'}" :aria-current="(view==='start')?'page':null" @click="go('start')">Getting started</button>
<button v-if="canRegister" class="rd-nav" :class="{active:view==='catalog'}" :aria-current="(view==='catalog')?'page':null" @click="go('catalog')">Catalog</button>
<button v-if="authed" class="rd-nav" :class="{active:view==='connections'||view==='provider'}" :aria-current="(view==='connections'||view==='provider')?'page':null" @click="go('connections')">Connections</button>
<button v-if="authed" class="rd-nav" :class="{active:view==='tools'||view==='secrets'||view==='resources'}" :aria-current="(view==='tools'||view==='secrets'||view==='resources')?'page':null" @click="go('tools')">Your own tools</button>
<button v-if="authed" class="rd-nav" :class="{active:view==='activity'}" :aria-current="(view==='activity')?'page':null" @click="go('activity')">Activity</button>
<button v-if="authed" class="rd-nav" :class="{active:view==='orgs'}" :aria-current="(view==='orgs')?'page':null" @click="go('orgs')">Team</button>
<button v-if="authed" class="rd-nav" :class="{active:view==='openenrich'||view==='hub'||view==='run'||moreOpen}" aria-haspopup="true" :aria-expanded="moreOpen" @click.stop="toggleMore">More ▾</button></nav>
      <div v-if="moreOpen" class="rd-more-panel" :style="moreAt" @click.stop>
        <button v-if="oeOn" :class="{current:view==='openenrich'}" @click="go('openenrich'); moreOpen=false"><b>openenrich</b><span>Build a list and enrich every row</span></button>
        <button v-if="hubOn" :class="{current:view==='hub'||view==='run'}" @click="go('hub'); moreOpen=false"><b>Hub</b><span>Tools made of tools, by makers</span></button>
        <a href="/enrich-arena"><b>Enrich Arena</b><span>Compare enrichment answers, providers, cost and speed</span></a>
        <a v-if="meta?.web_arena" href="/web-arena"><b>Web Arena</b><span>Compare search, fetch and other web tools on the same task</span></a>
      </div>
      <div class="rd-account">
        <a v-if="authed" class="rd-referral" href="#referrals" @click.prevent="go('referrals')" :aria-current="view==='referrals'?'page':null" :title="refEntryTitle()" :aria-label="'Referral: '+refEntryTitle()"><img src="/media/redesign/referral-gift.svg" alt=""><span>Referral</span></a>
        <button v-if="billing" class="rd-balance" :title="'Balance: '+money(billing.balance_micro)" @click="orgTab='billing'; go('orgs')"><span>Balance</span><b>{{moneyGlance(billing.balance_micro)}}</b></button>
        <details class="rd-account-menu" :ref="el => setElement('accountMenu', el)">
          <summary :aria-label="'Account: '+me"><span class="rd-avatar">{{initials}}</span></summary>
          <div class="rd-account-panel">
            <p class="rd-email">{{me}}</p>
            <button @click="toggleTheme">{{theme==='dark'?'Light appearance':'Dark appearance'}}</button>
            <button v-if="billing" @click="orgTab='billing'; go('orgs'); elements.accountMenu.open=false">Billing</button>
            <button v-if="isAdmin" @click="go('admin'); elements.accountMenu.open=false">Admin</button>
            <a href="/tutorial">Tutorial</a>
            <a href="https://github.com/superdesigndev/treg" target="_blank" rel="noopener">GitHub</a>
            <a href="https://discord.gg/6mQYYfFMAn" target="_blank" rel="noopener">Discord</a>
            <a href="https://x.com/treg_ai" target="_blank" rel="noopener">Follow on X</a>
            <button @click="logout">Sign out</button>
          </div>
        </details>
      </div>
    </header>
</template>
