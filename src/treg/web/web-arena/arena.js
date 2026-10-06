/* Web Arena keeps its query in session storage until sign-in. Results stay server-side. */
(() => {
  'use strict';
  if (!window.Vue) return;
  const draftKey='treg.web-arena.draft.v1';
  const teamKey='treg.arena.team';
  const signupSetupKey='treg.web-arena.signup-setup.v1';
  const resultViewKey='treg.web-arena.result-view.v1';
  const readResultView=()=>{try{return localStorage.getItem(resultViewKey)==='table'?'table':'cards';}catch{return 'cards';}};
  const saveDraft=d=>{try{sessionStorage.setItem(draftKey,JSON.stringify(d));}catch{}};
  const readDraft=()=>{try{return JSON.parse(sessionStorage.getItem(draftKey)||'null');}catch{return null;}};
  const readSignup=()=>{try{return JSON.parse(sessionStorage.getItem(signupSetupKey)||'null');}catch{return null;}};
  const clearSignup=()=>{try{sessionStorage.removeItem(signupSetupKey);}catch{}};
  Vue.createApp({
    components:{TregTryItOut:TregAgentSetup.TryItOut,TregAgentPicker:TregAgentSetup.AgentPicker,TregSetupInstructions:TregAgentSetup.SetupInstructions},
    data:()=>({tasks:[{id:'search',label:'Web Search',enabled:true},{id:'news',label:'News Search',enabled:true},{id:'papers',label:'Paper Search',enabled:true},{id:'youtube',label:'YouTube Search',enabled:true},{id:'maps',label:'Maps Search',enabled:true},{id:'fetch',label:'Web Fetch',enabled:true},{id:'sitemap',label:'Sitemap',enabled:true},{id:'brand',label:'Brand',enabled:false}],task:'search',value:'',query:'',mode:'battle',jev:true,
      user:null,teams:[],team:'',balance:null,quote:null,availableProviders:[],selected:[],run:null,resultView:readResultView(),history:[],live:null,insightsTimer:null,meta:{},
      leaderboardView:'rate',leaderboardOrientation:'vertical',chartFocus:null,
      busy:false,pricing:false,running:false,error:'',authError:'',authBusy:false,email:'',code:'',authStep:'email',devCode:'',poller:null,
      setupStep:1,setupTeamName:'',setupExampleCopied:'',setupAgentId:'claude-code',setupToken:null,setupShowToken:false,setupCopied:false,setupError:'',setupLoading:false,setupSequence:0,
      quoteTimer:null,quoteSequence:0,quotedKey:'',selectionTouched:false,rosterLeft:false,rosterRight:false,rosterObserver:null,
      taskLeft:false,taskRight:false,searchLeft:false,searchRight:false,taskObserver:null,expandedResults:{},expandedRows:{}}),
    watch:{task(){this.revealTask();},tasks(){this.revealTask();}},
    computed:{
      searchTasks(){return this.tasks.filter(t=>['search','news','papers','youtube','maps'].includes(t.id)).map(t=>({...t,label:({search:'Web',news:'News',papers:'Papers',youtube:'YouTube',maps:'Maps'})[t.id]}));},
      mainTasks(){return this.tasks.filter(t=>['search','fetch','sitemap','brand'].includes(t.id)).map(t=>({...t,label:({search:'Search',fetch:'Fetch'})[t.id]||t.label}));},
      taskGroup(){return ['search','news','papers','youtube','maps'].includes(this.task)?'search':this.task;},
      setupAgent(){return [...TregAgentSetup.agents,...TregAgentSetup.moreAgents].find(a=>a.id===this.setupAgentId)||TregAgentSetup.agents[0];},
      setupCommand(){return TregAgentSetup.command(this.meta.public_url||location.origin);},
      liveRows(){return this.live?.task_results?.[this.task]||[];},
      coverageBuilding(){const start=Date.parse(this.live?.observed_since||'');return Number.isFinite(start)&&Date.now()-start<30*24*60*60*1000;},
      leaderboardViews(){
        const common=[{id:'rate',label:'Hit rate'},{id:'price',label:'Price'},{id:'price_rate',label:'Price vs hit rate'}];
        if(['search','news','papers','youtube'].includes(this.task))common.splice(1,0,{id:'relevance',label:'Relevance'});
        if(this.task==='fetch')common.push({id:'coverage',label:'Fact coverage'},{id:'efficiency',label:'Token efficiency'},
          {id:'coverage_efficiency',label:'Fact coverage vs token efficiency'});
        return common;
      },
      leaderboardChartRows(){
        const colors=['#5b8f88','#7b8fae','#b39a69','#9787a6','#8b9c76','#b98476'];
        return this.liveRows.map((row,i)=>({...row,color:colors[i%colors.length],
          rate:Number.isFinite(row.success_rate)?row.success_rate:null,
          relevance:Number.isFinite(row.metric_percent)&&['search','news','papers','youtube'].includes(this.task)?row.metric_percent:null,
          coverage:Number.isFinite(row.metric_percent)&&this.task==='fetch'?row.metric_percent:null,
          efficiency:Number.isFinite(row.token_efficiency_percent)&&this.task==='fetch'?row.token_efficiency_percent:null,
          price:Number.isFinite(row.current_catalog_price_usd)?row.current_catalog_price_usd:null}));
      },
      leaderboardBars(){
        const field=this.leaderboardView==='price'?'price':this.leaderboardView==='relevance'?'relevance':
          this.leaderboardView==='coverage'?'coverage':this.leaderboardView==='efficiency'?'efficiency':'rate';
        return this.leaderboardChartRows.filter(row=>Number.isFinite(row[field])&&row[field]>=0)
          .map(row=>({...row,value:row[field]}))
          .sort((a,b)=>(field==='price'?a.value-b.value:b.value-a.value)||this.providerName(a.provider).localeCompare(this.providerName(b.provider)));
      },
      leaderboardPoints(){
        const fields=this.leaderboardView==='price_rate'?['price','rate']:['efficiency','coverage'];
        return this.leaderboardChartRows.filter(row=>fields.every(field=>Number.isFinite(row[field])&&row[field]>=0))
          .map(row=>({...row,x:row[fields[0]],y:row[fields[1]]}));
      },
      leaderboardMax(){return this.leaderboardView==='price'?Math.max(.0001,...this.leaderboardBars.map(row=>row.value)):100;},
      leaderboardXMax(){return this.leaderboardView==='price_rate'?Math.max(.0001,...this.leaderboardPoints.map(row=>row.x)):100;},
      leaderboardDetail(){return this.leaderboardChartRows.find(row=>row.provider===this.chartFocus)||null;},
      leaderboardSubtitle(){return ({rate:'Returned usable results · higher is better',relevance:'Jev estimated intent match · higher is better',
        price:'Current catalog price · cheapest first',price_rate:'Lower catalog price ← · ↑ higher hit rate',
        coverage:'Relative fact coverage · higher is better',efficiency:'Token efficiency · higher is better',
        coverage_efficiency:'Higher token efficiency → · ↑ higher fact coverage'})[this.leaderboardView];},
      qualityView(){return ['relevance','coverage','efficiency','coverage_efficiency'].includes(this.leaderboardView);},
      quoteKey(){return JSON.stringify([this.task,this.value.trim(),this.task==='sitemap'?this.query.trim():'',this.mode,this.jev,this.team,[...this.selected].sort()]);},
      readyQuote(){return this.quote&&this.quotedKey===this.quoteKey?this.quote:null;},
      displayProviders(){
        const available=new Map(this.availableProviders.map(p=>[p.provider,p]));
        const attempts=this.run?.attempts||[];
        const attempted=new Map(attempts.map(a=>[a.provider,a.estimate_micro]));
        const quoted=new Map((this.readyQuote?.providers||[]).map(p=>[p.provider,p.estimate_micro]));
        const price=p=>attempted.get(p.provider)??quoted.get(p.provider)??p.catalog_estimate_micro??null;
        const order=(a,b)=>Number(this.selected.includes(b.provider))-Number(this.selected.includes(a.provider))||
          (price(a)??Infinity)-(price(b)??Infinity)||a.provider.localeCompare(b.provider);
        if(this.running){
          if(attempts.length)return attempts.map(a=>available.get(a.provider)||{provider:a.provider,estimate_micro:a.estimate_micro});
          return this.selected.map(provider=>available.get(provider)).filter(Boolean).sort(order);
        }
        if(this.run&&attempts.length){
          const used=new Set(attempts.map(a=>a.provider));
          return [...attempts.map(a=>available.get(a.provider)||{provider:a.provider,estimate_micro:a.estimate_micro}),
            ...this.availableProviders.filter(p=>!used.has(p.provider))]
            .sort(order);
        }
        return [...this.availableProviders].sort(order);
      },
      battleAwards(){
        const awards={};
        if(this.run?.state!=='completed'||this.run.mode!=='battle')return awards;
        const results=(this.run.attempts||[]).filter(a=>a.state==='hit'&&a.rating!=='down');
        if(results.length<2)return awards;
        for(const [field,label] of [['duration_ms','Fastest'],['charged_micro','Cheapest']]){
          if(!results.every(a=>Number.isFinite(a[field])&&a[field]>=0))continue;
          const best=Math.min(...results.map(a=>a[field]));
          for(const a of results)if(a[field]===best)(awards[a.id]||=[]).push(label);
        }
        const scoredSearch=results.filter(a=>Number.isFinite(a.quality?.estimated_match)&&a.quality.estimated_match>=0&&a.quality.estimated_match<=100);
        if(['search','news','papers','youtube'].includes(this.run.task)&&scoredSearch.length>=2){
          const best=Math.max(...scoredSearch.map(a=>a.quality.estimated_match));
          for(const a of scoredSearch)if(a.quality.estimated_match===best)(awards[a.id]||=[]).push('Most Relevant');
        }
        if(this.run.task==='fetch'&&results.every(a=>Number.isFinite(a.quality?.token_efficiency)&&a.quality.token_efficiency>=0&&a.quality.token_efficiency<=100)){
          const best=Math.max(...results.map(a=>a.quality.token_efficiency));
          for(const a of results)if(a.quality.token_efficiency===best)(awards[a.id]||=[]).push('Token Efficient');
        }
        return awards;
      },
      runButtonLabel(){if(this.running)return 'Running…';if(this.busy)return 'Starting…';if(!this.user)return 'Sign up to run';if(this.pricing)return 'Updating price…';
        const q=this.readyQuote;if(!q)return this.mode==='battle'?'Run battle':'Run waterfall';
        if(!q.affordable)return q.limit_exceeded?'Select fewer providers':'Add team credits · '+this.usd(q.required_micro);
        return this.mode==='battle'?'Run battle · ~'+this.usd(q.required_micro):'Run waterfall from '+this.usd(q.required_micro);}
    },
    methods:{
      usd(n){return n===null||n===undefined?'—':'$'+(Number(n)/1e6).toFixed(4);},
      catalogPrice(row){return row?.price==null?'—':'$'+Number(row.price).toPrecision(4)+(row.price_unit?' / '+row.price_unit:'');},
      leaderboardValue(row){return this.leaderboardView==='price'?this.catalogPrice(row):this.percent(row.value);},
      leaderboardAxis(value){return this.leaderboardView==='price'?'$'+Number(value).toPrecision(2):Math.round(value)+'%';},
      leaderboardChartLabel(row){
        const counted=n=>`${n} checked ${n===1?'input':'inputs'}`;
        const quality=['search','news','papers','youtube'].includes(this.task)?` Relevance ${this.percent(row.relevance)} from ${counted(row.metric_sample_count)}.`:
          this.task==='fetch'?` Fact coverage ${this.percent(row.coverage)} from ${counted(row.metric_sample_count)}. Token efficiency ${this.percent(row.efficiency)} from ${counted(row.token_efficiency_sample_count)}.`:'';
        return `${this.providerName(row.provider)}. Hit rate ${this.percent(row.rate)} from ${row.hit_samples||0} decided calls.${quality} Response ${row.average_provider_ms==null?'—':row.average_provider_ms+' ms'} from ${row.time_samples||0} direct calls. Price ${this.catalogPrice(row)}.`;
      },
      leaderboardViewHelp(view){return ({relevance:'Jev estimates how well search links match the query. Uses quality-checked Web Arena Battle or waterfall results only.',coverage:'Share of facts from a shared list retained by this extract. Uses Web Arena runs with a completed fact-list and Jev check.',efficiency:'Text count per kept fact, scaled against other checked extracts from the same Web Arena run.',coverage_efficiency:'Compares relative fact coverage with token efficiency. Both come from completed Web Arena quality checks.'})[view]||'';},
      leaderboardDate(value){if(!value)return '';const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(date)+' · UTC';},
      chooseLeaderboardView(view){this.leaderboardView=view;this.leaderboardOrientation=view==='price'?'horizontal':'vertical';this.chartFocus=null;},
      setResultView(view){this.resultView=view;try{localStorage.setItem(resultViewKey,view);}catch{}},
      percent(n){return n===null||n===undefined?'—':Number(n).toFixed(1)+'%';},
      date(s){return s?new Date(s).toLocaleDateString():'';},
      providerName(provider){return ({branddev:'Context.dev',firecrawl:'Firecrawl',scrapegraphai:'ScrapeGraphAI',search1api:'Search1API',tinyfish:'TinyFish',you:'You.com',anyapi:'AnyAPI',serpapi:'SerpAPI',dataforseo:'DataForSEO'})[provider]||provider.charAt(0).toUpperCase()+provider.slice(1);},
      taskIcon(task){return ({search:'M20 20l-4.3-4.3M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z',news:'M4 4h12l4 4v12H4zM7 9h6m-6 3h10m-10 3h10M16 4v4h4',papers:'M4 3h12l4 4v14H4zM16 3v4h4M7 11h10M7 15h10M7 19h7',youtube:'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 8l6 4-6 4z',maps:'M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12ZM12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',fetch:'M8 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9l-5-5h-4M16 4v5h5M8 14h8m-8 3h5',sitemap:'M12 3v5m-7 6v-3h14v3M12 8v3M3 14h4v5H3zm7 0h4v5h-4zm7 0h4v5h-4z',brand:'M4 5h16v14H4zM8 14l3-3 3 3 2-2 4 4M8 8h.01'})[task]||'';},
      attemptFor(provider){return this.run?.attempts?.find(a=>a.provider===provider);},
      fighterIncluded(provider){return this.selected.includes(provider)||(this.running&&!!this.attemptFor(provider));},
      fighterAwards(provider){return this.battleAwards[this.attemptFor(provider)?.id]||[];},
      awardClass(badge){return badge.toLowerCase().replaceAll(' ','-');},
      awardDescription(badge){return ({Fastest:'Lowest provider time among successful, non-downvoted results',Cheapest:'Lowest actual charge among successful, non-downvoted results','Most Relevant':'Highest estimated intent match among scored successful, non-downvoted results','Token Efficient':'Fewest counted words and symbols per kept fact among scored results'})[badge]||badge;},
      fighterState(provider){
        if(!this.fighterIncluded(provider))return 'excluded';
        const attempt=this.attemptFor(provider);
        if(attempt?.rating==='down'||['miss','error','timeout'].includes(attempt?.state))return 'defeated';
        return ({hit:'won',running:'fighting',queued:'waiting',not_attempted:'benched',cancelled:'paused',interrupted:'paused'})[attempt?.state]||'ready';
      },
      fighterVerdict(provider){
        const attempt=this.attemptFor(provider),state=attempt?.state;
        if(attempt?.rating==='down')return 'Thumbs down';
        return ({hit:'Hit!',miss:'No result',error:'Error',timeout:'Timed out',running:'Running…',queued:'Waiting',not_attempted:'Not called',cancelled:'Stopped',interrupted:'Interrupted'})[state]||'';
      },
      attemptLabel(a){return ({hit:'Hit',miss:'No result',error:'Error',timeout:'Timed out',running:'Running',queued:'Waiting',not_attempted:'Not called',cancelled:'Stopped',interrupted:'Interrupted'})[a.state]||a.state;},
      searchResults(a){
        const items=this.task==='youtube'?a.output?.videos:this.task==='maps'?a.output?.places:a.output?.results;
        if(!Array.isArray(items))return [];
        return items.flatMap(item=>{
          const row=typeof item==='string'?{url:item}:item;
          if(!row||typeof row!=='object')return [];
          const rawUrl=[this.task==='maps'?(row.google_maps_url||row.place_id&&'https://www.google.com/maps/search/?api=1&query_place_id='+encodeURIComponent(row.place_id)):null,
            row.url,row.link,row.href,row.pageUrl,row.loc,
            this.task==='youtube'&&row.video_id?'https://www.youtube.com/watch?v='+encodeURIComponent(row.video_id):null,
            this.task==='maps'&&(row.title||row.name)?'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent([row.title||row.name,row.address].filter(Boolean).join(' ')):null]
            .find(value=>typeof value==='string'&&value.trim());
          if(!rawUrl)return [];
          let url;
          try{url=new URL(rawUrl);if(!['http:','https:'].includes(url.protocol))return [];}catch{return [];}
          const firstText=(keys)=>keys.map(key=>row[key]).find(value=>typeof value==='string'&&value.trim())?.trim()||'';
          return [{url:url.href,title:firstText(['title','name'])||url.href,
            description:this.task==='maps'?[firstText(['address']),Number.isFinite(row.rating)?row.rating+' stars':''].filter(Boolean).join(' · '):
              firstText(['snippet','description','description_snippet','text','content']),
            date:firstText(['publishedDate','published_at','published_date','datePublished','date','published','last_updated','updated_at'])}];
        });
      },
      resultHost(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}},
      fetchPreview(a){
        const pages=a.output?.pages;
        const page=Array.isArray(pages)?pages[0]:pages;
        if(typeof page==='string')return page.replace(/\s+/g,' ').trim().slice(0,280);
        if(!page||typeof page!=='object')return '';
        const text=[page.markdown?.data,page.markdown,page.markdown_content,page.text,page.raw_content,page.content]
          .find(value=>typeof value==='string'&&value.trim());
        return text?text.replace(/\s+/g,' ').replace(/^#+\s*/,'').trim().slice(0,280):'';
      },
      attemptMessage(a){if(a.state==='miss')return ({search:'No matching results returned.',news:'No matching news returned.',papers:'No matching papers returned.',youtube:'No matching videos returned.',maps:'No matching places returned.',fetch:'No usable page text returned.',sitemap:'No valid site URLs returned.'})[this.run?.task]||'No usable result returned.';if(this.run?.task==='news'&&a.provider==='tinyfish'&&a.status===429)return 'TinyFish search is rate limited.';return ({error:'This service could not complete the request.',timeout:'This service did not finish within the deadline.',running:'Waiting for the provider response…',queued:'Waiting for its turn.',not_attempted:'This provider was not called.',cancelled:'The attempt was stopped.',interrupted:'No complete result was recorded.'})[a.state]||'';},
      freshnessLabel(quality){
        const value=quality?.freshness_percent;
        if(value==null||!quality?.known_dates)return 'Freshness unknown';
        if(value>=80)return 'Mostly recent links';
        if(value>=30)return 'Some recent links';
        if(value>0)return 'Few recent links';
        return 'No recent dated links';
      },
      freshnessTone(quality){return quality?.freshness_percent>=80?'recent':quality?.freshness_percent>=30?'mixed':'stale';},
      async api(path,options={},teamOverride){
        const headers={'Content-Type':'application/json',...(options.headers||{})};
        const active=teamOverride===undefined?this.team:teamOverride;
        if(active)headers['X-Treg-Org']=active;
        const response=await fetch(path,{credentials:'same-origin',...options,headers});
        let body;try{body=await response.json();}catch{body={detail:'The server sent an unreadable response.'};}
        if(!response.ok){const d=body.detail;const e=new Error(typeof d==='string'?d:d?.message||'Request failed.');e.status=response.status;throw e;}
        return body;
      },
      remember(){saveDraft({task:this.task,value:this.value,query:this.query,mode:this.mode,jev:this.jev,selected:this.selected,at:Date.now()});},
      previewFor(task){return this.tasks.find(t=>t.id===task)?.provider_previews||[];},
      showPreview(){this.availableProviders=this.previewFor(this.task);this.selected=this.availableProviders.map(p=>p.provider);this.selectionTouched=false;this.resetRoster();},
      updateTaskOverflow(){const host=this.$refs.taskScroller;if(!host)return;this.taskLeft=host.scrollLeft>1;this.taskRight=host.scrollWidth-host.clientWidth-host.scrollLeft>1;},
      updateSearchOverflow(){const host=this.$refs.searchScroller;if(!host)return;this.searchLeft=host.scrollLeft>1;this.searchRight=host.scrollWidth-host.clientWidth-host.scrollLeft>1;},
      scrollTasks(direction){const host=this.$refs.taskScroller;if(!host)return;host.scrollBy({left:direction*Math.max(160,host.clientWidth*.65),behavior:'smooth'});},
      scrollSearch(direction){const host=this.$refs.searchScroller;if(!host)return;host.scrollBy({left:direction*Math.max(140,host.clientWidth*.65),behavior:'smooth'});},
      async revealTask(){await this.$nextTick();for(const host of [this.$refs.taskScroller,this.$refs.searchScroller]){if(!host||!host.offsetWidth)continue;const tab=host.querySelector('[aria-selected="true"]');if(tab&&host.scrollWidth>host.clientWidth){const box=host.getBoundingClientRect(),item=tab.getBoundingClientRect(),inset=36;if(item.left<box.left+inset)host.scrollLeft-=box.left+inset-item.left;else if(item.right>box.right-inset)host.scrollLeft+=item.right-box.right+inset;}}this.updateTaskOverflow();this.updateSearchOverflow();},
      taskKeydown(event){if(this.running)return;const tabs=[...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')],index=tabs.indexOf(event.target.closest('[role="tab"]'));const next=({ArrowRight:(index+1)%tabs.length,ArrowLeft:(index-1+tabs.length)%tabs.length,Home:0,End:tabs.length-1})[event.key];if(next!==undefined&&tabs[next]){event.preventDefault();tabs[next].focus();if(event.currentTarget.dataset.scope==='group')this.chooseGroup(tabs[next].dataset.task);else this.chooseTask(tabs[next].dataset.task);}},
      updateRoster(){const host=this.$refs.fighterRoster;if(!host)return;this.rosterLeft=host.scrollLeft>1;this.rosterRight=host.scrollWidth-host.clientWidth-host.scrollLeft>1;},
      scrollRoster(direction){const host=this.$refs.fighterRoster;if(!host)return;host.scrollBy({left:direction*Math.max(180,host.clientWidth*.7),behavior:'smooth'});},
      resetRoster(){this.$nextTick(()=>{const host=this.$refs.fighterRoster;if(host)host.scrollLeft=0;this.updateRoster();});},
      scheduleQuote(delay=650){clearTimeout(this.quoteTimer);this.quoteSequence++;this.quote=null;this.quotedKey='';this.pricing=false;
        if(!this.user||!this.team||this.running||!this.value.trim()||!this.selected.length)return;
        this.quoteTimer=setTimeout(()=>this.prepare(true),delay);},
      invalidate(){this.remember();this.scheduleQuote();},
      chooseGroup(group){if(this.taskGroup===group)return;this.chooseTask(group==='search'?'search':group);},
      chooseTask(task){if(this.task===task)return;this.task=task;this.value='';this.query='';this.run=null;this.leaderboardView='rate';this.leaderboardOrientation='vertical';this.chartFocus=null;this.showPreview();this.invalidate();},
      setMode(mode){if(this.mode===mode)return;this.mode=mode;this.invalidate();},
      toggleProvider(provider){if(this.running)return;
        const host=this.$refs.fighterRoster;
        const left=host?.scrollLeft||0;
        const bounds=host?.getBoundingClientRect();
        const anchor=host&&[...host.children].find(el=>el.dataset.provider&&el.dataset.provider!==provider&&
          el.getBoundingClientRect().right>bounds.left&&el.getBoundingClientRect().left<bounds.right);
        const anchorLeft=anchor?.getBoundingClientRect().left;
        const anchorProvider=anchor?.dataset.provider;
        this.selectionTouched=true;
        this.selected=this.selected.includes(provider)?this.selected.filter(p=>p!==provider):[...this.selected,provider];
        this.error=this.selected.length?'':'Select at least one provider.';this.invalidate();
        this.$nextTick(()=>{
          if(!host)return;
          const moved=[...host.children].find(el=>el.dataset.provider===anchorProvider);
          host.scrollLeft=moved?host.scrollLeft+moved.getBoundingClientRect().left-anchorLeft:left;
          this.updateRoster();
        });},
      async loadIdentity(){
        try{this.user=await this.api('/auth/me',{},'');}
        catch(e){if(e.status!==401)throw e;this.user=null;this.teams=[];this.team='';this.balance=null;return;}
        this.teams=(await this.api('/orgs',{},'')).filter(t=>!t.demo);
        let saved='';try{saved=localStorage.getItem(teamKey)||'';}catch{}
        this.team=this.teams.find(t=>t.slug===this.team)?.slug||this.teams.find(t=>t.slug===saved)?.slug||this.teams[0]?.slug||'';
        if(this.team)await this.loadBalance();
        this.scheduleQuote(0);
      },
      async loadBalance(){const team=this.teams.find(t=>t.slug===this.team);if(team)this.balance=(await this.api('/orgs/'+team.org_id+'/balance?limit=1')).balance_micro;},
      async reloadTeam(){try{localStorage.setItem(teamKey,this.team);}catch{}this.run=null;this.history=[];this.balance=null;this.showPreview();this.scheduleQuote(0);await this.loadBalance();await this.loadHistory();},
      async loadInsights(){try{this.live=await this.api('/web-arena/api/leaderboard',{cache:'no-store'},'');}catch{this.live={status:'error',task_results:{}};}},
      async loadHistory(){if(this.user&&this.team)this.history=await this.api('/web-arena/api/runs');},
      async openSetup(){
        this.setupStep=this.user&&!this.team?0:1;this.setupTeamName='';this.setupToken=null;this.setupShowToken=false;this.setupCopied=false;this.setupError='';this.setupLoading=false;this.setupSequence++;
        try{const saved=localStorage.getItem('treg-agent');if([...TregAgentSetup.agents,...TregAgentSetup.moreAgents].some(a=>a.id===saved))this.setupAgentId=saved;}catch{}
        await this.$nextTick();this.$refs.setupDialog.showModal();
      },
      closeSetup(){if(this.setupStep===0&&this.setupLoading)return;this.setupSequence++;this.setupToken=null;this.setupShowToken=false;this.setupCopied=false;this.setupLoading=false;this.$refs.setupDialog.close();},
      async createSetupTeam(){
        if(this.setupLoading||!this.user)return;
        const name=this.setupTeamName.trim();
        if(!name){this.setupError='Give your team a name.';return;}
        this.setupLoading=true;this.setupError='';
        try{const created=await this.api('/orgs',{method:'POST',body:JSON.stringify({name})},'');this.team=created.org;try{localStorage.setItem(teamKey,this.team);}catch{}this.setupStep=1;await this.loadIdentity();await this.loadHistory();}
        catch(e){this.setupError=e.message;}
        finally{this.setupLoading=false;}
      },
      async prepareSetup(){
        if(this.setupLoading)return;
        if(this.user&&!this.team){this.setupStep=0;return;}
        const sequence=++this.setupSequence,team=this.team,user=this.user;
        this.setupLoading=true;this.setupError='';this.setupToken=null;this.setupShowToken=false;this.setupCopied=false;
        try{
          try{localStorage.setItem('treg-agent',this.setupAgentId);}catch{}
          if(user&&team){
            const result=await this.api('/auth/cli-token',{},team);
            if(sequence!==this.setupSequence||team!==this.team||user!==this.user)return;
            if(!result.token)throw new Error('Could not load your setup key. Please try again.');
            this.setupToken=result.token;
          }
          if(sequence===this.setupSequence)this.setupStep=2;
        }catch(e){if(sequence===this.setupSequence)this.setupError=e.message;}
        finally{if(sequence===this.setupSequence)this.setupLoading=false;}
      },
      showSetupExamples(){this.setupStep=3;this.setupShowToken=false;this.setupExampleCopied='';this.setupError='';},
      openSetupCatalog(service){this.closeSetup();location.assign(service?'/app/marketplace/'+encodeURIComponent(service):'/app#connections');},
      async copySetup(value,exampleKey=''){
        const sequence=this.setupSequence;this.setupError='';
        try{await navigator.clipboard.writeText(value);if(sequence!==this.setupSequence)return;this.setupCopied=!exampleKey;this.setupExampleCopied=exampleKey;setTimeout(()=>{if(sequence===this.setupSequence){this.setupCopied=false;this.setupExampleCopied='';}},1400);}
        catch{if(sequence===this.setupSequence)this.setupError='Could not copy. Select the setup text and copy it manually.';}
      },
      async openLogin(){this.remember();this.authError='';this.authStep='email';this.code='';this.devCode='';await this.$nextTick();this.$refs.login.showModal();},
      closeLogin(){clearSignup();this.$refs.login.close();},
      socialLogin(provider){this.remember();try{sessionStorage.setItem(signupSetupKey,JSON.stringify({at:Date.now()}));}catch{}const target=(location.pathname||'/web-arena')+(location.search||'');location.assign('/auth/'+provider+'?return_to='+encodeURIComponent(target));},
      async finishSignup(){clearSignup();await this.openSetup();},
      async resumeSignupSetup(){const pending=readSignup();if(!pending)return false;if(!Number.isFinite(pending.at)||Date.now()-pending.at>600000||pending.at>Date.now()){clearSignup();return false;}if(!this.user)return false;await this.finishSignup();return true;},
      async sendCode(){this.authBusy=true;this.authError='';try{const r=await this.api('/auth/email/start',{method:'POST',body:JSON.stringify({email:this.email})},'');this.authStep='code';this.devCode=r.dev_code||'';}catch(e){this.authError=e.message;}finally{this.authBusy=false;}},
      async verifyCode(){this.authBusy=true;this.authError='';try{await this.api('/auth/email/verify',{method:'POST',body:JSON.stringify({email:this.email,code:this.code})},'');this.$refs.login.close();await this.loadIdentity();await this.finishSignup();}catch(e){this.authError=e.message;}finally{this.authBusy=false;}},
      async logout(){try{await this.api('/auth/logout',{method:'POST'});this.user=null;this.teams=[];this.team='';this.balance=null;this.quote=null;this.run=null;this.history=[];this.showPreview();this.scheduleQuote();}catch(e){this.error=e.message;}},
      async prepare(quiet=false){
        clearTimeout(this.quoteTimer);
        if(!this.user||!this.team||this.running||!this.value.trim()||!this.selected.length)return;
        const sequence=++this.quoteSequence,team=this.team,task=this.task,value=this.value.trim(),query=task==='sitemap'?this.query.trim():'',mode=this.mode,jev=this.jev;
        const selection=[...this.selected],touched=this.selectionTouched;
        this.pricing=true;this.quote=null;this.quotedKey='';this.error='';this.remember();
        try{
          const request=providers=>this.api('/web-arena/api/quotes',{method:'POST',body:JSON.stringify({task,value,query,mode,jev,providers})},team);
          const full=await request(null);
          if(sequence!==this.quoteSequence||team!==this.team||task!==this.task||value!==this.value.trim()||query!==(this.task==='sitemap'?this.query.trim():'')||mode!==this.mode||jev!==this.jev)return;
          const previews=new Map(this.previewFor(task).map(p=>[p.provider,p]));
          this.availableProviders=full.providers.map(p=>({...previews.get(p.provider),...p}));
          this.$nextTick(()=>this.updateRoster());
          const eligible=new Set(full.providers.map(p=>p.provider));
        this.selected=touched?selection.filter(p=>eligible.has(p)):full.providers.map(p=>p.provider);
          if(!this.selected.length){this.error='None of the selected providers can use this input. Choose another provider.';return;}
          const allSelected=this.selected.length===full.providers.length;
          const q=allSelected?full:await request(this.selected);
          if(sequence!==this.quoteSequence||team!==this.team||task!==this.task||value!==this.value.trim()||query!==(this.task==='sitemap'?this.query.trim():'')||mode!==this.mode||jev!==this.jev)return;
          this.quote=q;this.quotedKey=this.quoteKey;this.balance=q.balance_micro;
        }catch(e){if(sequence===this.quoteSequence){this.error=e.message;this.quote=null;if(e.status===401)this.user=null;}}
        finally{if(sequence===this.quoteSequence)this.pricing=false;}
      },
      async submit(){
        if(this.busy||this.running||this.pricing)return;
        if(!this.value.trim()){this.error='Enter a query or URL.';return;}
        if(!this.selected.length){this.error='Select at least one provider.';return;}
        if(!this.user){this.openLogin();return;}
        if(!this.team){await this.openSetup();return;}
        if(!this.readyQuote||Date.parse(this.readyQuote.expires_at)<=Date.now())await this.prepare(false);
        const q=this.readyQuote;if(!q)return;
        if(!q.affordable){this.error=q.limit_exceeded?'Select fewer providers to stay within the $10 run limit.':'Add team credits to run this quote.';return;}
        await this.start();
      },
      async start(){
        const quote=this.readyQuote;if(!quote||!this.selected.length)return;
        this.busy=true;this.error='';
        try{const r=await this.api('/web-arena/api/runs/'+quote.id+'/start',{method:'POST'});this.quote=null;this.quotedKey='';this.running=true;this.run={id:r.id,state:'running',attempts:[]};await this.poll();if(this.running)this.poller=setInterval(()=>this.poll(),1500);}
        catch(e){this.error=e.message;}finally{this.busy=false;}
      },
      async poll(){
        if(!this.run)return;
        let latest;
        try{latest=await this.api('/web-arena/api/runs/'+this.run.id);}
        catch(e){this.error='Could not refresh the run. Retrying…';return;}
        this.run=latest;
        if(this.error==='Could not refresh the run. Retrying…')this.error='';
        if(this.run.state==='running')return;
        clearInterval(this.poller);this.poller=null;this.running=false;
        try{await this.loadHistory();await this.loadBalance();await this.loadInsights();this.scheduleQuote(0);}
        catch(e){this.error=e.message;}
      },
      async loadRun(id){this.error='';try{const run=await this.api('/web-arena/api/runs/'+id);clearInterval(this.poller);this.poller=null;this.running=run.state==='running';this.run=run;this.task=run.task;this.leaderboardView='rate';this.leaderboardOrientation='vertical';this.chartFocus=null;this.value=run.input;this.query=run.query||'';this.mode=run.mode;this.jev=run.jev;this.showPreview();this.selected=run.attempts.map(a=>a.provider);this.selectionTouched=true;this.resetRoster();this.scheduleQuote();if(this.running)this.poller=setInterval(()=>this.poll(),1500);}catch(e){this.error=e.message;}},
      newRun(){clearInterval(this.poller);this.poller=null;this.running=false;this.run=null;this.value='';this.query='';this.showPreview();this.scheduleQuote();this.remember();},
      async cancel(){try{await this.api('/web-arena/api/runs/'+this.run.id+'/cancel',{method:'POST'});await this.poll();}catch(e){this.error=e.message;}},
      async rate(a,value){try{await this.api('/web-arena/api/runs/'+this.run.id+'/attempts/'+a.id+'/rating',{method:'POST',body:JSON.stringify({value})});a.rating=value;}catch(e){this.error=e.message;}}
    },
    async mounted(){
      if(this.$refs.taskScroller){this.taskObserver=new ResizeObserver(()=>this.revealTask());this.taskObserver.observe(this.$refs.taskScroller);this.taskObserver.observe(this.$refs.searchScroller);this.revealTask();}
      if(this.$refs.fighterRoster){this.rosterObserver=new ResizeObserver(()=>this.updateRoster());this.rosterObserver.observe(this.$refs.fighterRoster);}
      const draft=readDraft();if(draft&&Date.now()-draft.at<600000){this.task=draft.task||'search';this.value=draft.value||'';this.query=draft.query||'';this.mode=draft.mode==='waterfall'?'waterfall':'battle';this.jev=draft.jev!==false;}
      try{
        [this.tasks,this.meta]=await Promise.all([this.api('/web-arena/api/tasks',{},''),this.api('/meta',{},'').catch(()=>({}))]);
        this.showPreview();
        if(draft&&Date.now()-draft.at<600000&&Array.isArray(draft.selected)&&draft.selected.length){
          const visible=new Set(this.availableProviders.map(p=>p.provider));
          this.selected=draft.selected.filter(p=>visible.has(p));
          this.selectionTouched=this.selected.length!==this.availableProviders.length;
        }
        await this.loadInsights();
        await this.loadIdentity();await this.loadHistory();await this.resumeSignupSetup();
        const id=new URLSearchParams(location.search).get('run');if(id&&this.user)await this.loadRun(id);
        this.insightsTimer=setInterval(()=>{if(!document.hidden)this.loadInsights();},120000);
      }catch(e){this.error=e.message;}
    },
    unmounted(){clearInterval(this.poller);clearInterval(this.insightsTimer);clearTimeout(this.quoteTimer);this.quoteSequence++;this.rosterObserver?.disconnect();this.taskObserver?.disconnect();}
  }).mount('#web-arena');
})();
