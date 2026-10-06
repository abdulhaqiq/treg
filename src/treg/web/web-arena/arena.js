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
      leaderboardView:'price',leaderboardOrientation:'horizontal',chartFocus:null,
      busy:false,pricing:false,running:false,error:'',authError:'',authBusy:false,email:'',code:'',authStep:'email',devCode:'',poller:null,
      setupStep:1,setupTeamName:'',setupExampleCopied:'',setupAgentId:'claude-code',setupToken:null,setupShowToken:false,setupCopied:false,setupError:'',setupLoading:false,setupSequence:0,
      quoteTimer:null,quoteSequence:0,quotedKey:'',selectionTouched:false,tabObserver:null,expandedResults:{},expandedRows:{},
      clock:0,clockTimer:null,seenRunning:{},liveRun:false,runStartedAt:0,runEndedAt:0,finale:false,stageShown:false,rosterOpen:false,rosterSettled:false,taskLeft:false,taskRight:false,topicOpen:false,allLeaving:false,allTimer:null}),
    watch:{task(){this.revealTask();},tasks(){this.revealTask();},mode(){this.$nextTick(()=>this.moveTabs(this.$refs.modeTabs,true));}},
    computed:{
      urlTask(){return ['fetch','sitemap'].includes(this.task);},
      inputLabel(){return ({search:'Search query',news:'News topic',papers:'Research topic',youtube:'Video topic',maps:'Business and location',fetch:'Page URL',sitemap:'Site URL'})[this.task]||'Query';},
      inputPlaceholder(){return ({search:'What do you want to find?',news:'What news are you looking for?',papers:'What papers are you looking for?',youtube:'What videos are you looking for?',maps:'Coffee shops in Austin, TX',fetch:'https://example.com/page',sitemap:'https://example.com'})[this.task]||'';},
      priceNote(){const q=this.readyQuote;
        if(q)return (this.mode==='waterfall'?'First provider from '+this.usd(q.required_micro):this.selected.length+' providers · '+this.usd(q.estimate_micro)+' estimated')+' · final charge may vary';
        if(!this.user)return 'Sign up to see your team price';if(this.pricing)return 'Updating price…';return '';},
      rosterProviders(){
        const quoted=new Map((this.readyQuote?.providers||[]).map(p=>[p.provider,p.estimate_micro]));
        const price=p=>quoted.get(p.provider)??p.catalog_estimate_micro??null;
        return [...this.availableProviders].sort((a,b)=>(price(a)??Infinity)-(price(b)??Infinity)||a.provider.localeCompare(b.provider));
      },
      setupFeatured(){const all=TregAgentSetup.agents.concat(TregAgentSetup.moreAgents);return ['claude-code','codex','openclaw','hermes'].map(id=>all.find(a=>a.id===id)).filter(Boolean);},
      setupOtherCount(){return TregAgentSetup.agents.length+TregAgentSetup.moreAgents.length-this.setupFeatured.length;},
      lanes(){
        if(!this.run)return [];
        if(this.run.attempts?.length)return this.run.attempts;
        const quoted=new Map((this.availableProviders||[]).map(p=>[p.provider,p]));
        return this.selected.map(provider=>({id:'pending-'+provider,provider,state:'queued',estimate_micro:quoted.get(provider)?.estimate_micro??null,charged_micro:null}));
      },
      // After a run, never-called providers fold into one line; during a run every lane shows.
      shownLanes(){
        if(!this.run)return [];
        if(this.run.mode!=='waterfall')return this.running?this.lanes:this.lanes.filter(a=>a.state!=='not_attempted');
        // A Waterfall is a relay: only providers that tried, or the one about to, get a card.
        const tried=this.lanes.filter(a=>!['queued','not_attempted'].includes(a.state));
        // A result ends the relay, so nobody steps up while it is still being checked.
        if(this.running&&!tried.some(a=>['running','hit'].includes(a.state))){const next=this.lanes.find(a=>a.state==='queued');if(next)tried.push(next);}
        return tried;
      },
      queueLanes(){if(!this.running||this.run?.mode!=='waterfall'||this.lanes.some(a=>a.state==='hit'))return [];const shown=new Set(this.shownLanes.map(a=>a.provider));return this.lanes.filter(a=>a.state==='queued'&&!shown.has(a.provider));},
      skippedText(){
        const n=this.skippedLanes.length,who=n===1?'provider':'providers',run=this.run,reason=run?.stop_reason||'';
        if(run.state==='cancelled')return `${n} ${who} not called: the run stopped first. Not charged.`;
        if(run.mode==='waterfall'){
          if(reason.includes('$10'))return `${n} ${who} not called: the next one would pass the $10 run limit. Not charged.`;
          if(reason.includes('fee is not known')){const last=[...this.lanes].reverse().find(a=>['error','timeout'].includes(a.state));return `${n} ${who} not called: ${last?this.providerName(last.provider)+"'s":'a'} fee isn't known yet, so the run stopped to be safe. Not charged.`;}
          const winner=this.lanes.find(a=>a.state==='hit');
          if(winner)return `${n} ${who} not needed: ${this.providerName(winner.provider)} returned results. Not charged.`;
        }
        return `${n} ${who} not called. Not charged.`;
      },
      skippedLanes(){return this.running?[]:this.lanes.filter(a=>a.state==='not_attempted');},
      showAllSwitch(){return this.allLeaving||(this.availableProviders.length>0&&this.selected.length<this.availableProviders.length);},
      rosterOf(){const total=this.availableProviders.length,extra=this.selected.length-this.rosterStack.length;
        if(!total)return '';if(extra>0)return `+${extra} of ${total}`;return this.selected.length<total?`of ${total}`:'';},
      linkLimit(){return this.run?.mode==='battle'?3:4;},
      rosterStack(){const chosen=new Set(this.selected);return this.rosterProviders.filter(p=>chosen.has(p.provider)).slice(0,8);},
      // The query shows above results only when the box no longer holds it.
      queryChanged(){return !!this.run&&(this.run.input!==this.value.trim()||(this.run.query||'')!==(this.task==='sitemap'?this.query.trim():'')||this.run.task!==this.task);},
      doneCount(){return this.lanes.filter(a=>!['queued','running'].includes(a.state)).length;},
      progress(){return this.lanes.length?Math.round(100*this.doneCount/this.lanes.length):0;},
      stageStatus(){
        if(!this.run)return '';
        const total=this.lanes.length,hits=this.lanes.filter(a=>a.state==='hit').length;
        if(this.running)return `${this.run.mode==='battle'?'Battle':'Waterfall'} · ${this.doneCount} of ${total} done`+(this.runStartedAt?' · '+this.fmtSeconds(this.clock-this.runStartedAt):'');
        const took=this.liveRun&&this.runEndedAt?' · '+this.fmtSeconds(this.runEndedAt-this.runStartedAt):'';
        if(this.run.state==='cancelled')return `Stopped · ${hits} of ${total} returned results`+took;
        if(this.run.state==='interrupted')return `Interrupted · ${hits} of ${total} returned results`;
        return `${hits} of ${total} returned results`+took;
      },
      setupAgent(){return [...TregAgentSetup.agents,...TregAgentSetup.moreAgents].find(a=>a.id===this.setupAgentId)||TregAgentSetup.agents[0];},
      setupCommand(){return TregAgentSetup.command(this.meta.public_url||location.origin);},
      liveRows(){return this.live?.task_results?.[this.task]||[];},
      coverageBuilding(){const start=Date.parse(this.live?.observed_since||'');return Number.isFinite(start)&&Date.now()-start<30*24*60*60*1000;},
      leaderboardViews(){
        const common=[{id:'price',label:'Price'},{id:'rate',label:'Hit rate'},{id:'price_rate',label:'Price vs hit rate'}];
        if(['search','news','papers','youtube'].includes(this.task))common.splice(2,0,{id:'relevance',label:'Relevance'});
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
      usdShort(n){return n===null||n===undefined?'—':'$'+(Number(n)/1e6).toFixed(2);},
      fmtMs(ms){if(ms==null)return '—';return ms<1000?Math.round(ms)+' ms':(ms/1000).toFixed(ms<10000?2:1)+' s';},
      fmtSeconds(ms){return Math.max(0,ms/1000).toFixed(1)+'s';},
      // Number pop-in: the last two characters ride in behind the rest.
      digits(text){const chars=String(text).split('');return chars.map((c,i)=>({c,stagger:i===chars.length-2?'1':i===chars.length-1?'2':null}));},
      liveMs(a){const since=this.seenRunning[a.id];return a.state==='running'&&since?Math.max(0,this.clock-since):null;},
      providerPrice(p){const quoted=(this.readyQuote?.providers||[]).find(q=>q.provider===p.provider)?.estimate_micro;
        const est=quoted??p.catalog_estimate_micro;if(est===0)return 'Free';
        if(quoted!=null)return '~'+this.usd(quoted)+' quoted';if(est!=null)return '~'+this.usd(est)+' estimated';return 'price on quote';},
      taskTab(id){return ({search:'Web',news:'News',papers:'Papers',youtube:'YouTube',maps:'Maps',fetch:'Fetch',sitemap:'Sitemap',brand:'Brand'})[id]||id;},
      taskTitle(id){return this.tasks.find(t=>t.id===id)?.label||this.taskTab(id);},
      setupIcon(icon){return TregAgentSetup.iconUrl(icon);},
      laneFighter(a){
        if(a.rating==='down'||['miss','error','timeout'].includes(a.state))return 'defeated';
        return ({hit:'won',running:'fighting',queued:'waiting',not_attempted:'benched',cancelled:'paused',interrupted:'paused'})[a.state]||'waiting';
      },
      checking(a){return this.running&&a.state==='hit'&&this.run?.jev&&!a.quality&&!['sitemap','maps'].includes(this.run.task);},
      laneState(a){
        if(this.checking(a))return 'checking';
        return ({queued:'waiting',running:'running',hit:'hit',miss:'down',error:'down',timeout:'down',not_attempted:'skipped',cancelled:'stopped',interrupted:'stopped'})[a.state]||'waiting';
      },
      laneShimmer(a){return ['running','checking'].includes(this.laneState(a))||this.laneStatus(a)==='Starting…';},
      laneStatus(a){
        const task=this.run?.task;
        if(a.state==='queued'){if(!this.running)return 'Not called';if(this.run.mode!=='battle')return 'Starting…';
          return this.lanes.filter(l=>l.state==='running').length<4?'Starting…':'Waiting for a slot';}
        if(a.state==='running')return ({search:'Searching the web…',news:'Searching the news…',papers:'Searching papers…',youtube:'Searching videos…',maps:'Searching places…',fetch:'Reading the page…',sitemap:'Mapping the site…'})[task]||'Running…';
        if(this.checking(a))return 'Checking quality…';
        if(a.state==='hit'){
          const n=this.searchResults(a).length;
          const valid=a.quality?.unique_valid_urls;
          const found=task==='fetch'?'Page text returned':task==='sitemap'?(valid==null?n+' site URLs':valid===n?n+' valid site URLs':n+' site URLs · '+valid+' valid'):n+' '+(({news:'articles',papers:'papers',youtube:'videos',maps:'places'})[task]||'results');
          const match=a.quality?.estimated_match!=null?' · '+Math.round(a.quality.estimated_match)+'% intent match':'';
          return found+match;
        }
        if(a.state==='not_attempted')return this.run?.mode==='waterfall'&&this.run.state==='completed'?'Not needed: an earlier provider answered.':'Not called';
        if(a.state==='cancelled')return 'Run stopped';
        return this.attemptMessage(a)||this.attemptLabel(a);
      },
      // Badge winners of a finished Battle take the pixel fighter's victory pose instead of an orb.
      laneBody(a){return a.state==='hit'||!!(a.output&&Object.keys(a.output).length)||(!!a.detail&&a.state!=='hit');},
      canRate(a){return ['hit','miss','error','timeout'].includes(a.state)&&!this.running;},
      updateTaskOverflow(){const bar=this.$refs.taskTabs;if(!bar)return;this.taskLeft=bar.scrollLeft>1;this.taskRight=bar.scrollWidth-bar.clientWidth-bar.scrollLeft>1;},
      scrollTasks(direction){const bar=this.$refs.taskTabs;if(!bar)return;bar.scrollBy({left:direction*Math.max(160,bar.clientWidth*.6),behavior:this.reduceMotion()?'auto':'smooth'});},
      async openTopic(){this.topicOpen=true;await this.$nextTick();this.$refs.topicInput?.focus();},
      clearTopic(){this.query='';this.topicOpen=false;this.invalidate();},
      champion(a){return this.run?.state==='completed'&&a.state==='hit'&&a.rating!=='down'&&!!this.battleAwards[a.id]?.length;},
      fetchMetrics(a){return this.run?.task==='fetch'&&!!a.quality&&(a.quality.tokens!=null||a.quality.relative_coverage!=null||a.quality.token_efficiency!=null);},
      searchFreshness(a){return ['search','news'].includes(this.run?.task)&&a.state==='hit'&&a.quality?.freshness_percent!=null;},
      // The switch only appears while some providers are off; turned on, it slides on, holds, then fades.
      flipAll(event){if(!event.target.checked||this.running)return;this.selectAll();this.allLeaving=true;clearTimeout(this.allTimer);this.allTimer=setTimeout(()=>{this.allLeaving=false;},760);},
      selectAll(){this.selected=this.availableProviders.map(p=>p.provider);this.selectionTouched=false;this.error='';this.invalidate();},
      topUp(){this.remember();try{localStorage.setItem('treg-active',this.team);}catch{}location.assign('/app?from=web-arena#billing');},
      // Tabs sliding (transitions.dev): the pill tweens to the active tab; first paint and resizes jump.
      moveTabs(bar,animate){
        if(!bar)return;const pill=bar.querySelector('.t-tabs-pill');
        const tab=bar.querySelector('.t-tab[aria-selected="true"],.t-tab[data-active="true"]');
        if(!pill||!tab||!tab.offsetWidth){if(pill)pill.style.opacity='0';return;}
        pill.style.opacity='1';
        if(!animate){const prev=pill.style.transition;pill.style.transition='none';pill.style.transform=`translateX(${tab.offsetLeft}px)`;pill.style.width=`${tab.offsetWidth}px`;void pill.offsetWidth;pill.style.transition=prev;}
        else{pill.style.transform=`translateX(${tab.offsetLeft}px)`;pill.style.width=`${tab.offsetWidth}px`;}
      },
      reduceMotion(){return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;},
      async showStage(scroll){
        this.stageShown=false;await this.$nextTick();
        requestAnimationFrame(()=>{this.stageShown=true;if(scroll)this.$refs.stage?.scrollIntoView({behavior:this.reduceMotion()?'auto':'smooth',block:'start'});});
      },
      startClock(){this.stopClock();this.clock=Date.now();this.clockTimer=setInterval(()=>{this.clock=Date.now();},100);},
      stopClock(){clearInterval(this.clockTimer);this.clockTimer=null;},
      resetLive(){this.stopClock();this.seenRunning={};this.liveRun=false;this.runStartedAt=0;this.runEndedAt=0;this.finale=false;this.expandedResults={};this.expandedRows={};},
      // The run API has no per-attempt start time; the browser times what it watches.
      track(run){
        if(!this.liveRun)return;
        const now=Date.now(),seen={...this.seenRunning};
        for(const a of run.attempts||[])if(a.state==='running'&&!seen[a.id])seen[a.id]=now;
        this.seenRunning=seen;
      },
      catalogPrice(row){if(row?.price==null)return '—';if(Number(row.price)===0)return 'Free';return '$'+Number(row.price).toPrecision(4)+(row.price_unit?' / '+row.price_unit:'');},
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
      awardClass(badge){return badge.toLowerCase().replaceAll(' ','-');},
      awardDescription(badge){return ({Fastest:'Lowest provider time among successful, non-downvoted results',Cheapest:'Lowest actual charge among successful, non-downvoted results','Most Relevant':'Highest estimated intent match among scored successful, non-downvoted results','Token Efficient':'Fewest counted words and symbols per kept fact among scored results'})[badge]||badge;},
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
        let response;
        try{response=await fetch(path,{credentials:'same-origin',...options,headers});}
        catch{const e=new Error("Can't reach treg right now. Check your connection and try again.");e.status=0;throw e;}
        let body;try{body=await response.json();}catch{body={detail:'The server sent an unreadable response.'};}
        if(!response.ok){const d=body.detail;const e=new Error(typeof d==='string'?d:d?.message||'Request failed.');e.status=response.status;throw e;}
        return body;
      },
      remember(){saveDraft({task:this.task,value:this.value,query:this.query,mode:this.mode,jev:this.jev,selected:this.selected,at:Date.now()});},
      previewFor(task){return this.tasks.find(t=>t.id===task)?.provider_previews||[];},
      showPreview(){this.availableProviders=this.previewFor(this.task);this.selected=this.availableProviders.map(p=>p.provider);this.selectionTouched=false;},
      async revealTask(){await this.$nextTick();const bar=this.$refs.taskTabs;if(!bar)return;const tab=bar.querySelector('[aria-selected="true"]');
        if(tab&&bar.scrollWidth>bar.clientWidth){const box=bar.getBoundingClientRect(),item=tab.getBoundingClientRect(),inset=24;if(item.left<box.left+inset)bar.scrollLeft-=box.left+inset-item.left;else if(item.right>box.right-inset)bar.scrollLeft+=item.right-box.right+inset;}
        this.moveTabs(bar,true);this.updateTaskOverflow();},
      taskKeydown(event){if(this.running)return;const tabs=[...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')],index=tabs.indexOf(event.target.closest('[role="tab"]'));const next=({ArrowRight:(index+1)%tabs.length,ArrowLeft:(index-1+tabs.length)%tabs.length,Home:0,End:tabs.length-1})[event.key];if(next!==undefined&&tabs[next]){event.preventDefault();tabs[next].focus();this.chooseTask(tabs[next].dataset.task);}},
      scheduleQuote(delay=650){clearTimeout(this.quoteTimer);this.quoteSequence++;this.quote=null;this.quotedKey='';this.pricing=false;
        if(!this.user||!this.team||this.running||!this.value.trim()||!this.selected.length)return;
        this.quoteTimer=setTimeout(()=>this.prepare(true),delay);},
      invalidate(){this.remember();this.scheduleQuote();},
      chooseTask(task){if(this.task===task||this.running)return;this.task=task;this.value='';this.query='';this.topicOpen=false;this.run=null;this.resetLive();this.leaderboardView='price';this.leaderboardOrientation='horizontal';this.chartFocus=null;this.showPreview();this.invalidate();},
      setMode(mode){if(this.mode===mode)return;this.mode=mode;this.invalidate();},
      toggleProvider(provider){if(this.running)return;
        this.selectionTouched=true;
        this.selected=this.selected.includes(provider)?this.selected.filter(p=>p!==provider):[...this.selected,provider];
        this.error=this.selected.length?'':'Select at least one provider.';this.invalidate();},
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
      async reloadTeam(){try{localStorage.setItem(teamKey,this.team);}catch{}this.run=null;this.resetLive();this.history=[];this.balance=null;this.showPreview();this.scheduleQuote(0);await this.loadBalance();await this.loadHistory();},
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
      async verifyCode(){this.authBusy=true;this.authError='';try{await this.api('/auth/email/verify',{method:'POST',body:JSON.stringify({email:this.email,code:this.code})},'');this.$refs.login.close();await this.loadIdentity();await this.loadHistory();await this.finishSignup();}catch(e){this.authError=e.message;}finally{this.authBusy=false;}},
      async logout(){try{await this.api('/auth/logout',{method:'POST'});this.user=null;this.teams=[];this.team='';this.balance=null;this.quote=null;this.run=null;this.resetLive();this.history=[];this.showPreview();this.scheduleQuote();}catch(e){this.error=e.message;}},
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
        if(!q.affordable){if(q.limit_exceeded){this.error='Select fewer providers to stay within the $10 run limit.';return;}this.topUp();return;}
        await this.start();
      },
      async start(){
        const quote=this.readyQuote;if(!quote||!this.selected.length)return;
        this.busy=true;this.error='';
        try{const r=await this.api('/web-arena/api/runs/'+quote.id+'/start',{method:'POST'});this.quote=null;this.quotedKey='';
          this.resetLive();this.liveRun=true;this.runStartedAt=Date.now();this.startClock();this.rosterOpen=false;this.rosterSettled=false;
          this.running=true;this.run={id:r.id,task:this.task,mode:this.mode,jev:this.jev,input:this.value,query:this.task==='sitemap'?this.query:'',state:'running',attempts:[]};
          this.showStage(true);await this.poll();if(this.running)this.poller=setInterval(()=>this.poll(),1500);}
        catch(e){this.error=e.message;}finally{this.busy=false;}
      },
      async poll(){
        if(!this.run)return;
        let latest;
        try{latest=await this.api('/web-arena/api/runs/'+this.run.id);}
        catch(e){this.error='Could not refresh the run. Retrying…';return;}
        this.track(latest);this.run=latest;
        if(this.error==='Could not refresh the run. Retrying…')this.error='';
        if(this.run.state==='running')return;
        clearInterval(this.poller);this.poller=null;this.running=false;this.stopClock();
        if(this.liveRun){this.runEndedAt=Date.now();this.finale=this.run.state==='completed';}
        try{await this.loadHistory();await this.loadBalance();await this.loadInsights();this.scheduleQuote(0);}
        catch(e){this.error=e.message;}
      },
      async loadRun(id){this.error='';try{const run=await this.api('/web-arena/api/runs/'+id);clearInterval(this.poller);this.poller=null;this.resetLive();this.running=run.state==='running';
        if(this.running){this.liveRun=true;this.runStartedAt=Date.now();this.startClock();this.track(run);}
        this.run=run;this.task=run.task;this.leaderboardView='price';this.leaderboardOrientation='horizontal';this.chartFocus=null;this.value=run.input;this.query=run.query||'';this.topicOpen=!!this.query;this.mode=run.mode;this.jev=run.jev;this.showPreview();this.selected=run.attempts.map(a=>a.provider);this.selectionTouched=true;this.scheduleQuote();
        this.showStage(true);if(this.running)this.poller=setInterval(()=>this.poll(),1500);}catch(e){this.error=e.message;}},
      newRun(){clearInterval(this.poller);this.poller=null;this.running=false;this.run=null;this.resetLive();this.value='';this.query='';this.topicOpen=false;this.showPreview();this.scheduleQuote();this.remember();window.scrollTo({top:0,behavior:this.reduceMotion()?'auto':'smooth'});},
      async cancel(){try{await this.api('/web-arena/api/runs/'+this.run.id+'/cancel',{method:'POST'});await this.poll();}catch(e){this.error=e.message;}},
      async rate(a,value){try{await this.api('/web-arena/api/runs/'+this.run.id+'/attempts/'+a.id+'/rating',{method:'POST',body:JSON.stringify({value})});a.rating=value;}catch(e){this.error=e.message;}}
    },
    async mounted(){
      const measure=()=>{this.moveTabs(this.$refs.taskTabs,false);this.moveTabs(this.$refs.modeTabs,false);this.updateTaskOverflow();};
      this.tabObserver=new ResizeObserver(measure);for(const bar of [this.$refs.taskTabs,this.$refs.modeTabs])if(bar)this.tabObserver.observe(bar);
      document.fonts?.ready.then(measure);
      const draft=readDraft();if(draft&&Date.now()-draft.at<600000){this.task=draft.task||'search';this.value=draft.value||'';this.query=draft.query||'';this.topicOpen=!!this.query;this.mode=draft.mode==='waterfall'?'waterfall':'battle';this.jev=draft.jev!==false;}
      try{
        [this.tasks,this.meta]=await Promise.all([this.api('/web-arena/api/tasks',{},''),this.api('/meta',{},'').catch(()=>({}))]);
        this.showPreview();this.$nextTick(()=>{this.moveTabs(this.$refs.taskTabs,false);this.moveTabs(this.$refs.modeTabs,false);});
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
    unmounted(){clearInterval(this.poller);clearInterval(this.insightsTimer);clearTimeout(this.quoteTimer);this.stopClock();this.quoteSequence++;clearTimeout(this.allTimer);this.tabObserver?.disconnect();}
  }).mount('#web-arena');
})();
