/**
 * Portfolio Tracker — the application.
 *
 * This lived inline in index.html. It was moved out so the Content-Security-Policy
 * could drop 'unsafe-inline' from script-src: with an inline script the browser cannot
 * tell the one you wrote from one an attacker injected, so the policy had to permit
 * both and was doing nothing against XSS. Served from the allowlist in server.js.
 *
 * Editing this file is deploying it — pm2 watches it.
 */
(function(){
  "use strict";

  /* ================= auth ================= */
  var currentUser=null; // {id, email} once signed in

  // All API calls go through here so a dropped/expired session lands the user
  // back on the sign-in gate instead of failing silently mid-render.
  // Cookies ride along automatically (same-origin), so no headers are needed.
  function apiFetch(path, options){
    var opts=options||{};
    opts.credentials="same-origin";
    return fetch(path, opts).then(function(r){
      if(r.status===401){
        currentUser=null;
        showAuthGate();
        throw new Error("Not authenticated");
      }
      return r;
    });
  }

  function showAuthGate(){
    var gate=document.getElementById("auth-gate");
    if(gate) gate.hidden=false;
    document.getElementById("auth-form").hidden=false;
    document.getElementById("auth-sent").hidden=true;
  }
  function hideAuthGate(){
    var gate=document.getElementById("auth-gate");
    if(gate) gate.hidden=true;
  }
  function renderAuthStatus(){
    var el=document.getElementById("auth-status");
    if(!el) return;
    el.innerHTML=currentUser
      ? ' &middot; '+esc(currentUser.email)+' &middot; <a id="auth-logout">Log out</a>'
      : '';
    var out=document.getElementById("auth-logout");
    if(out) out.addEventListener("click",function(){
      fetch("./api/auth/logout",{method:"POST",credentials:"same-origin"})
        .catch(function(){})
        .then(function(){ location.reload(); });
    });
  }

  /* ================= base data: 74 screenshots, Jun 2023 - Aug 2026 (EXIF dates) ================= */
  /* name index: 0 Tesla 1 VW 2 Lufthansa 3 Meta 4 Palantir 5 Nvidia 6 ASML 7 Oracle 8 AMD 9 Qualcomm 10 ServiceNow 11 Microsoft */
  var BNAMES=["Tesla","Volkswagen","Deutsche Lufthansa","Meta Platforms","Palantir","Nvidia","ASML Holding","Oracle","AMD","Qualcomm","ServiceNow","Microsoft","SPDR S&P 500 ETF Trust"];
  var BSHORT=["Tesla","VW","Lufthansa","Meta","Palantir","Nvidia","ASML","Oracle","AMD","Qualcomm","ServiceNow","Microsoft","S&P 500 ETF"];
  var BKEY=["tsla","vw","lha","meta","pltr","nvda","asml","orcl","amd","qcom","now","msft","spy"];

  // Ticker to name mapping for dynamic snapshots from API
  var TICKER_NAMES = {
    'TSLA': 'Tesla', 'VW': 'Volkswagen', 'LHA': 'Deutsche Lufthansa',
    'META': 'Meta Platforms', 'PLTR': 'Palantir', 'NVDA': 'Nvidia',
    'ASML': 'ASML Holding', 'ORCL': 'Oracle', 'AMD': 'AMD',
    'QCOM': 'Qualcomm', 'NOW': 'ServiceNow', 'MSFT': 'Microsoft', 'SPY': 'SPDR S&P 500 ETF Trust',
    // European listings carry an exchange suffix, which is part of the Yahoo symbol
    'ASML.AS': 'ASML Holding', 'VOW3.DE': 'Volkswagen', 'LHA.DE': 'Deutsche Lufthansa'
  };

  // Ticker to currency mapping (USD by default if not in this map)
  var TICKER_CURRENCY = {
    'TSLA': 'USD', 'AMD': 'USD', 'QCOM': 'USD', 'NVDA': 'USD', 'MSFT': 'USD',
    'META': 'USD', 'ORCL': 'USD', 'NOW': 'USD', 'PLTR': 'USD'
  };

  var BASE_RAW = []; // Will be populated from API
  var LATEST_PRICES = {}; // ticker -> {priceEUR, priceUSD, priceNative, currency, date, updatedAt}
  var CURRENT_MARKET_VALUE = null; // calculated from latest holdings + prices
  var CURRENT_COST_BASIS = null; // cost basis of current portfolio
  var STOCK_SPLITS = []; // {ticker, date, ratio, description}
  var TICKER_EXCHANGE_RATE = {}; // ticker -> exchange rate used in transactions

  /* ================= helpers ================= */
  var nfEur2=new Intl.NumberFormat("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2});
  var nfEur0=new Intl.NumberFormat("de-DE",{maximumFractionDigits:0});
  function eur(v){ return "\u20ac\u00a0"+nfEur2.format(v); }
  function usd(v){ return "$\u00a0"+nfEur2.format(v); }
  function showCurrencyValue(ticker,v){ return (TICKER_CURRENCY[ticker]==="USD"?usd(v):eur(v)); }
  // Market prices are shown in the currency their exchange quotes; only aggregated
  // portfolio value is expressed in euros.
  var CURRENCY_SYMBOL={USD:"$",EUR:"€",GBP:"£",CHF:"CHF ",JPY:"¥",CAD:"CA$",AUD:"A$"};
  function fmtNative(v,cur){
    if(v==null) return "—";
    var s=CURRENCY_SYMBOL[cur];
    return s?s+" "+nfEur2.format(v):nfEur2.format(v)+" "+(cur||"");
  }
  function comma(x){ return String(x).replace(".",","); }
  function d0(v){ return (v>=0?"+":"\u2212")+"\u20ac"+nfEur0.format(Math.abs(Math.round(v))); }
  function dp(v){ return (v>=0?"+":"\u2212")+comma(Math.abs(v*100).toFixed(1))+"%"; }
  function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"").slice(0,14)||"x"; }
  // Escapes the same five characters as escapeHtml() on the server. It used to do
  // three, leaving > and ' alone. That was safe as it was used — every value lands
  // in a text node or a double-quoted attribute — but it is not safe as a general
  // tool, and the day someone writes a single-quoted attribute it becomes a hole
  // with nothing to warn them. Two escapers with two different definitions is the
  // real defect; now there is one definition in two places.
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  // BKEY holds the short names this app started with, so a symbol carrying an exchange
  // suffix (ASML.AS, VOW3.DE) misses it and used to fall through to the raw symbol.
  function tickerLabel(t){
    if(!t) return "";
    return BSHORT[BKEY.indexOf(String(t).toLowerCase())] || TICKER_NAMES[String(t).toUpperCase()] || t;
  }
  // Symbols are stored exactly as Yahoo knows them (price-fetch.js quotes them
  // unchanged), so the quote page is a straight substitution — suffixes included.
  function yahooQuoteLink(t, label, cls){
    var sym=String(t||"").trim();
    if(!sym) return esc(label==null?t:label);
    return '<a class="'+(cls||"tk-link")+'" href="https://finance.yahoo.com/quote/'
      +encodeURIComponent(sym)+'/" target="_blank" rel="noopener noreferrer"'
      +' title="'+esc(sym)+' on Yahoo Finance">'+esc(label==null?sym:label)+'</a>';
  }
  var fmtDayY=new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short",year:"numeric"});
  var fmtDay=new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short"});
  function shortDate(ts){ return fmtDay.format(new Date(ts)); }
  function stampLabel(ts){ var d=new Date(ts); return fmtDayY.format(d)+", "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); }
  function el(tag,attrs){ var e=document.createElementNS("http://www.w3.org/2000/svg",tag); if(attrs) for(var k in attrs) e.setAttribute(k,attrs[k]); return e; }

  /* ---- empty charts ----
     A new account used to get a tall blank rectangle inside an otherwise complete panel:
     period buttons, currency toggle and legend all present, framing nothing. Every chart
     now falls back to the same picture — its own axes, drawn at zero, with a caption and
     the one action that changes anything. */
  function clearEmptyChart(svg){
    var host=svg&&svg.parentNode; if(!host) return;
    var old=host.querySelector(".chart-empty"); if(old) old.parentNode.removeChild(old);
  }
  function drawEmptyChart(svg, caption, withButton){
    if(!svg) return;
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    var vb=(svg.getAttribute("viewBox")||"0 0 960 400").split(/[\s,]+/).map(Number);
    var W=vb[2]||960, H=vb[3]||400, l=72, r=110, tp=24, bt=40;
    var pW=W-l-r, pH=H-tp-bt, rows=4;
    for(var i=0;i<=rows;i++){
      var y=tp+pH*(i/rows), zero=(i===rows);
      svg.appendChild(el("line",{x1:l,x2:W-r,y1:y,y2:y,
        stroke:zero?"var(--faint)":"var(--grid)","stroke-width":zero?1.5:1,
        "stroke-dasharray":zero?"none":"4 4"}));
      if(zero){ var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5});
        lb.textContent="\u20ac 0"; svg.appendChild(lb); }
    }
    var now=new Date();
    for(var k=5;k>=0;k--){
      var m=new Date(now.getFullYear(), now.getMonth()-k, 1);
      var t=el("text",{class:"xlbl",x:l+pW*((5-k)/5),y:tp+pH+22});
      t.textContent=m.toLocaleDateString("en-GB",{month:"short"}); svg.appendChild(t);
    }
    var host=svg.parentNode;
    if(!host) return;
    clearEmptyChart(svg);
    var div=document.createElement("div"); div.className="chart-empty";
    div.innerHTML='<p>'+esc(caption)+'</p>'+
      (withButton?'<button type="button" class="btn primary chart-empty-cta">Register your first transaction</button>':'');
    host.appendChild(div);
    var cta=div.querySelector(".chart-empty-cta");
    if(cta) cta.addEventListener("click",goToFirstTransaction);
  }
  function goToFirstTransaction(){
    var t=document.getElementById("tab-add"); if(t) t.click();
    var f=document.getElementById("tx-ticker");
    if(f) setTimeout(function(){ f.scrollIntoView({block:"center",behavior:"smooth"}); f.focus(); },250);
  }
  function kpiCard(k){ return '<div class="kpi"><div class="k-label">'+k.l+'</div><div class="k-val">'+k.v+'</div>'+(k.s?'<div class="k-sub '+(k.c||"")+'">'+k.s+'</div>':'')+'</div>'; }
  function emptyKpiStrip(){
    // five cards holding their place, rather than a band that appears out of nowhere
    // the moment the first transaction lands
    var strip=document.getElementById("kpi-strip");
    if(strip) strip.innerHTML=[
      {l:"Current value", v:eur(0)},
      {l:"Since", v:"\u2014", s:"no transactions yet"},
      {l:"Peak value", v:"\u2014"},
      {l:"Lowest value", v:"\u2014"},
      {l:"Max drawdown", v:"\u2014"}
    ].map(kpiCard).join("");
  }
  // End-of-series labels sit at their own value, so two series that finish close
  // together print on top of each other — the Bollinger chart stacked "Upper" and
  // "Price" into one unreadable line whenever the price ran at the band. Nudge them
  // apart in order, exactly as the main chart already does for its own labels.
  function placeEndLabels(svg,x,items){
    items.slice().sort(function(a,b){ return a.y-b.y; }).forEach(function(it,i,arr){
      if(i && it.y-arr[i-1].y<12) it.y=arr[i-1].y+12;
      var t=el("text",{class:"endlbl",x:x,y:it.y+3.5,fill:it.fill});
      t.textContent=it.text; svg.appendChild(t);
    });
  }
  function isBuyIdx(q,i){ return q[i]!=null && ((i>0 && q[i-1]==null) || (i>0 && q[i-1]!=null && q[i]>q[i-1])); }
  function num(x){ if(x===""||x==null) return null; var v=+x; return isNaN(v)?null:v; }

  /* ================= persistence ================= */
  var STORE_KEY="pf.snapshots.v1";
  // Snapshots live on the server and are derived from transactions; this browser-side
  // copy is the legacy of an earlier design and now only distorts the chart, so it is
  // dropped on sight rather than read.
  function loadUser(){ try{ localStorage.removeItem(STORE_KEY); }catch(e){} return []; }
  function saveUser(){ /* nothing is stored client-side any more */ }
  var userEntries=loadUser();

  function normUser(e){
    var pos=(e&&Array.isArray(e.pos)?e.pos:[]).map(function(p){
      return {name:String(p&&p.name||"").trim(), qty:num(p&&p.qty), amount:num(p&&p.amount), rent:num(p&&p.rent)};
    }).filter(function(p){ return p.name && p.amount!=null && p.amount>0; });
    var ts=+e.ts; if(isNaN(ts)) ts=Date.parse(e.ts)||Date.now();
    return {id:String(e.id||("u"+ts)), ts:ts, src:(e.src==="ai"?"ai":"manual"), pos:pos};
  }

  /* ================= dataset (base + user) ================= */
  var entries,SNAP,T,T0,T1,n,UNI,TOTAL,TSLAV,EXV,ALL,INVESTED,DD,GROWTH;

  function rebuild(){
    userEntries=userEntries.map(normUser).filter(function(e){ return e.pos.length; });

    var base=BASE_RAW.map(function(r,i){
      var pos=r[1].map(function(p){ return {name:BNAMES[p[0]], qty:p[1], amount:p[2], rent:(p[3]==null?null:p[3])}; });
      return {id:"b"+i, ts:new Date(r[0]).getTime(), src:"base", pos:pos};
    });

    entries=base.concat(userEntries).sort(function(a,b){ return a.ts-b.ts; });
    n=entries.length;
    SNAP=entries.map(function(e){ return {ts:e.ts, label:e.label||stampLabel(e.ts), src:e.src}; });
    T=entries.map(function(e){ return e.ts; }); T0=T[0]; T1=T[n-1];

    var order=BNAMES.slice(), seen={};
    BNAMES.forEach(function(nm){ seen[nm]=1; });
    entries.forEach(function(e){ e.pos.forEach(function(p){ if(!seen[p.name]){ seen[p.name]=1; order.push(p.name); } }); });

    UNI=order.map(function(name){
      var bi=BNAMES.indexOf(name);
      var vals=[], qty=[], rents=[], lastQ=null;
      entries.forEach(function(e){
        var p=null; for(var z=0;z<e.pos.length;z++) if(e.pos[z].name===name) p=e.pos[z];
        vals.push(p?p.amount:null);
        if(p){ if(p.qty!=null) lastQ=p.qty; qty.push(lastQ); } else qty.push(null);
        rents.push(p&&p.rent!=null?p.rent:null);
      });
      var rl=null; for(var i=n-1;i>=0;i--){ if(rents[i]!=null){ rl=rents[i]; break; } }
      return {key:bi>=0?BKEY[bi]:slug(name), name:name, short:bi>=0?BSHORT[bi]:(name.length>11?name.slice(0,11):name),
              vals:vals, qty:qty, rents:rents, rentLatest:rl};
    });

    TOTAL=[]; TSLAV=[]; EXV=[];
    for(var i=0;i<n;i++){
      var s=0, held=false, tv=null;
      UNI.forEach(function(u){ if(u.vals[i]!=null){ s+=u.vals[i]; held=true; if(u.name==="Tesla") tv=u.vals[i]; } });
      TOTAL.push(held?Math.round(s*100)/100:null);
      TSLAV.push(tv);
      EXV.push(held?Math.round((s-(tv||0))*100)/100:null);
    }

    var teslaU=null; for(var z=0;z<UNI.length;z++) if(UNI[z].name==="Tesla") teslaU=UNI[z];
    ALL=[{key:"_total",name:"Total stocks",agg:true,arr:TOTAL},
         {key:"_tesla",name:"Tesla",agg:true,arr:TSLAV,qty:teslaU?teslaU.qty:null},
         {key:"_ex",name:"Ex-Tesla",agg:true,arr:EXV}]
      .concat(UNI.map(function(u){ return {key:u.key,name:u.name,arr:u.vals,qty:u.qty}; }));

    selected=selected.filter(function(k){ return ALL.some(function(a){return a.key===k;}); });
    // The chart opens on the portfolio itself. The Tesla / Ex-Tesla split is a view of
    // one holding against the rest — useful, but a choice to make rather than the first
    // thing you are shown; the Totals button puts all three back in one click.
    if(!selected.length) selected=["_total"];

    /* ---- estimated invested capital (cost basis) per snapshot ---- */
    var cbBy={};
    INVESTED=[];
    for(var i=0;i<n;i++){
      var inv=0, any=false;
      for(var u=0;u<UNI.length;u++){
        var U=UNI[u], v=U.vals[i], rt=U.rents[i], q=U.qty[i];
        if(v==null){ continue; }
        any=true;
        var cb=cbBy[U.name];
        if(rt!=null){ cb=v/(1+rt/100); }                    // exact: back out cost from return %
        else if(cb==null){ cb=v; }                          // first seen, no return %: assume cost ~ value
        else if(q!=null && U.qty[i-1]!=null && q>U.qty[i-1]){ cb+=(q-U.qty[i-1])*(v/q); } // bought more: add at current price
        cbBy[U.name]=cb;
        inv+=cb;
      }
      INVESTED.push(any?Math.round(inv*100)/100:null);
    }

    /* ---- drawdown (underwater) ---- */
    DD=[]; var rpk=-Infinity;
    for(var i=0;i<n;i++){ if(TOTAL[i]==null){ DD.push(null); continue; } if(TOTAL[i]>rpk) rpk=TOTAL[i]; DD.push(TOTAL[i]/rpk-1); }

    /* ---- return figures ---- */
    var invEnd=INVESTED[n-1], valEnd=TOTAL[n-1], gain=valEnd-invEnd;
    var twr=1;
    for(var i=1;i<n;i++){
      if(TOTAL[i]==null||TOTAL[i-1]==null||INVESTED[i]==null||INVESTED[i-1]==null) continue;
      var contrib=INVESTED[i]-INVESTED[i-1]; if(contrib<0) contrib=0;
      var pr=(TOTAL[i]-contrib)/TOTAL[i-1]-1;
      twr*=(1+pr);
    }
    twr-=1;
    var yrs=Math.max((T1-T0)/(365*864e5),1/365);
    GROWTH={
      invStart:INVESTED[0], invEnd:invEnd, valEnd:valEnd, gain:gain,
      gainPct:gain/invEnd, added:invEnd-INVESTED[0],
      twr:twr, twrAnn:Math.pow(1+twr,1/yrs)-1,
      ddMin:Math.min.apply(null,DD.filter(function(x){return x!=null;})),
      ddNow:DD[n-1], years:yrs
    };

    var fr=document.getElementById("firstrun"); if(fr) fr.hidden=!!n;
    renderHeadline();
    renderPicker(); renderMain(); renderEventsTimeline();
    renderPortfolioDetail();
    renderTable();
  }

  function monthTicks(){
    var span=(new Date(chartT1).getFullYear()-new Date(chartT0).getFullYear())*12 + (new Date(chartT1).getMonth()-new Date(chartT0).getMonth());
    var useQuarters = span > 6;
    var out=[], d=new Date(chartT0); d.setDate(1); d.setHours(0,0,0,0);

    if(useQuarters){
      // Show quarters: year label first, then quarters, format like "2022    Q1    Q2    Q3    2023"
      while(d.getMonth()%3!==0) d.setMonth(d.getMonth()+1);
      var currentYear=null;
      var guard=0;
      while(d.getTime()<=chartT1 && guard++<200){
        if(d.getTime()>=chartT0){
          var year=d.getFullYear();
          if(year!==currentYear){
            // The year label stands in for that quarter — pushing both put "2026" and
            // "Q1" on the same x, one printed over the other.
            out.push({t:d.getTime(), lab:String(year), isYear:true});
            currentYear=year;
          } else {
            out.push({t:d.getTime(), lab:"Q"+(Math.floor(d.getMonth()/3)+1)});
          }
        }
        d.setMonth(d.getMonth()+3);
      }
    } else {
      // Show months
      d=new Date(chartT0); d.setDate(1); d.setHours(0,0,0,0);
      var guard=0;
      while(d.getTime()<=chartT1 && guard++<200){
        if(d.getTime()>=chartT0){
          var lab = d.toLocaleDateString("en-GB",{month:"short"}) + (span>2 ? " ‘"+String(d.getFullYear()).slice(2) : "");
          out.push({t:d.getTime(), lab:lab});
        }
        d.setMonth(d.getMonth()+1);
      }
    }
    return out;
  }

  function renderHeadline(){
    // With no transactions T is empty, and new Date(undefined) made Intl throw here —
    // aborting rebuild() before the picker, the charts, the KPI strip and the tables
    // had drawn anything. The blank new-account page was one uncaught RangeError.
    if(!n){
      document.getElementById("h-value").textContent=eur(0);
      var d0e=document.getElementById("h-delta");
      d0e.className="delta"; d0e.textContent="Nothing recorded yet";
      document.getElementById("eyebrow-range").textContent="No data yet";
      emptyKpiStrip();
      return;
    }
    var marketValue = CURRENT_MARKET_VALUE || TOTAL[n-1] || 0;
    var costBasis = CURRENT_COST_BASIS || 0;

    document.getElementById("h-value").textContent=eur(marketValue);
    var de=document.getElementById("h-delta");

    if(costBasis > 0){
      var gain = marketValue - costBasis;
      de.className="delta "+(gain>=0?"pos":"neg");
      de.textContent="Basis: "+eur(costBasis)+" \u2022 Gain: "+(gain>=0?"+":"\u2212")+"\u20ac"+nfEur2.format(Math.abs(gain))+"  ("+dp(gain/costBasis)+")";
    } else {
      de.className="delta";
      de.textContent="\u2014";
    }
    document.getElementById("eyebrow-range").textContent="Last updated: "+fmtDayY.format(new Date(T[n-1]));
  }

  /* ================= VIEW 1 : time series ================= */
  var svg=document.getElementById("chart"), tip=document.getElementById("tip"), box=svg.parentNode;
  var D={w:960,h:540,l:72,r:140,t:28,b:44};
  var pW=D.w-D.l-D.r, pH=D.h-D.t-D.b;
  var mode="eur", DOMc=[0,1], selected=["_total"], capTimer;
  var CURRENT_EUR_TO_USD=1.087; // Default exchange rate, updated from latest prices
  var timePeriod="all"; // Current time period filter: 1m, 3m, 6m, 1y, 3y, 5y, or all
  var PAL_L=["#2a78d6","#eb6834","#1baf7a","#eda100","#e87ba4","#008300","#4a3aa7","#e34948"];
  var PAL_D=["#3987e5","#d95926","#199e70","#c98500","#d55181","#008300","#9085e9","#e66767"];
  // Eight is not an arbitrary cap: it is how many categorical hues stay tellable apart,
  // including under the red/green colour-blindness simulations these two palettes were
  // validated against. A ninth hue would be a colour somebody cannot distinguish from one
  // already on the chart. So the ninth line reuses the first hue and adds a second channel
  // instead — it is drawn dashed. Eight hues x two dash styles = sixteen lines, every one
  // of them a unique pair. Add a third dash style here if the cap ever needs to go higher.
  var DASH=["","7 4"];
  var CAP=PAL_L.length*DASH.length;
  function byKey(k){ for(var i=0;i<ALL.length;i++) if(ALL[i].key===k) return ALL[i]; }
  function isDark(){
    var t=document.documentElement.getAttribute("data-theme");
    if(t==="dark") return true; if(t==="light") return false;
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function palette(){ return isDark()?PAL_D:PAL_L; }
  /* A colour belongs to a series, not to its position in `selected`. Colouring by that
     position meant removing one line repainted every line after it, so the same stock
     changed colour because a *different* one was dropped — and a colour read off the
     chart a moment ago no longer meant the same holding.
     Each shown series now holds a slot of its own until it is itself removed. A series
     prefers the slot it held last time, falling back to one derived from its fixed place
     in ALL, so a holding keeps its colour across a remove-and-re-add and across reloads
     too; the preference is only ever given up when another series already holds it. */
  var slotOf={}, lastSlot={};
  function defaultSlot(k){ for(var i=0;i<ALL.length;i++) if(ALL[i].key===k) return i%CAP; return 0; }
  function syncSlots(){
    if(!ALL) return;
    var taken={}, k;
    for(k in slotOf){
      if(selected.indexOf(k)<0){ lastSlot[k]=slotOf[k]; delete slotOf[k]; }
      else taken[slotOf[k]]=1;
    }
    selected.forEach(function(k){
      if(slotOf[k]!=null) return;
      var want=lastSlot[k]!=null?lastSlot[k]:defaultSlot(k);
      // toggle() caps the selection at CAP, so a free slot always exists
      if(taken[want]){ want=0; while(taken[want]&&want<CAP-1) want++; }
      slotOf[k]=want; taken[want]=1;
    });
  }
  function slotFor(k){ return slotOf[k]!=null?slotOf[k]:0; }
  function colorOf(k){ return selected.indexOf(k)<0?"var(--faint)":palette()[slotFor(k)%palette().length]; }
  function dashOf(k){ return selected.indexOf(k)<0?"":DASH[Math.floor(slotFor(k)/palette().length)%DASH.length]; }
  // the legend, picker and tooltip show a sample of the line itself, so a dashed
  // series is identifiable there and not only out on the chart
  function swatchCSS(k){
    var c=colorOf(k), d=dashOf(k);
    return d?"background:repeating-linear-gradient(90deg,"+c+" 0 5px,transparent 5px 8px)":"background:"+c;
  }
  function firstNN(a){ for(var i=0;i<n;i++) if(a[i]!=null) return i; return 0; }
  function sval(o,i){ if(o.arr[i]==null) return null; return mode==="eur"?o.arr[i]:o.arr[i]*CURRENT_EUR_TO_USD; }
  function X(i){ return D.l+(T[i]-chartT0)/((chartT1-chartT0)||1)*pW; }
  function Y(v){ return D.t+(1-(v-DOMc[0])/((DOMc[1]-DOMc[0])||1))*pH; }
  function isInChartRange(i){ return T[i]>=chartT0 && T[i]<=chartT1; }
  function computeDomain(){
    var lo=Infinity,hi=-Infinity;
    selected.forEach(function(k){ var s=byKey(k); if(!s) return;
      for(var i=0;i<n;i++){ var v=s.arr[i]; if(v==null) continue; if(v<lo)lo=v; if(v>hi)hi=v; } });
    if(!isFinite(lo)) return [0,1];
    if(lo===hi) return [lo-1,hi+1];
    var pad=(hi-lo)*0.08; return [lo-pad,hi+pad];
  }
  function niceTicks(lo,hi,c){
    var span=hi-lo; if(span<=0) return [lo];
    var step=500;
    var tickCount=span/step;
    if(tickCount>10) step=1000;
    if(tickCount>15) step=2000;
    if(tickCount>20) step=5000;
    var out=[], start=Math.ceil(lo/step)*step;
    for(var v=start;v<=hi+step*0.5;v+=step) out.push(Math.round(v*1e6)/1e6);
    return out;
  }
  function getTimeRange(){
    // Calculate the earliest date from selected stocks
    var minT=T0;
    selected.forEach(function(k){
      var s=byKey(k); if(!s) return;
      for(var i=0;i<n;i++) if(s.arr[i]!=null){ minT=Math.min(minT,T[i]); break; }
    });

    // Apply time period filter
    var maxT=T1;
    if(timePeriod!=="all"){
      var now=new Date().getTime();
      var days={"1m":30,"3m":90,"6m":180,"1y":365,"3y":1095,"5y":1825}[timePeriod]||365;
      maxT=Math.min(maxT,now);
      minT=Math.max(minT,now-days*24*3600*1000);
    }

    return {t0:minT,t1:maxT};
  }
  var chartT0=T0, chartT1=T1; // Chart display time range
  function renderMain(){
    syncSlots();
    // ALL is only populated by rebuild(), which needs loaded data. The default
    // time-period button is clicked at script load and the OS theme listener can
    // fire at any time, so both can reach here before (or without) a signed-in
    // session — there is simply nothing to draw yet.
    if(!ALL) return;
    if(!n){
      drawEmptyChart(svg,"Your portfolio starts at zero. Register a transaction and this chart fills in from your own history \u2014 market value against what you put in, from your first buy to today.",true);
      renderLegend();
      return;
    }
    clearEmptyChart(svg);
    while(svg.firstChild) svg.removeChild(svg.firstChild);

    // Get adjusted time range for X-axis
    var tr=getTimeRange();
    chartT0=tr.t0;
    chartT1=tr.t1;

    DOMc=computeDomain();
    niceTicks(DOMc[0],DOMc[1],5).forEach(function(tk){
      var y=Y(tk); if(y<D.t-1||y>D.t+pH+1) return;
      svg.appendChild(el("line",{class:"gridline",x1:D.l,x2:D.w-D.r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:D.l-10,y:y+3.5});
      lb.textContent=mode==="eur"?nfEur0.format(tk):Math.round(tk*CURRENT_EUR_TO_USD); svg.appendChild(lb);
    });
    svg.appendChild(el("line",{class:"gridline",x1:D.l,x2:D.w-D.r,y1:D.t+pH,y2:D.t+pH}));
    monthTicks().forEach(function(m){
      var x=D.l+(m.t-chartT0)/((chartT1-chartT0)||1)*pW;
      if(x<D.l||x>D.w-D.r) return;
      if(!m.isYear){
        svg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:D.t,y2:D.t+pH,"stroke-dasharray":"2 3"}));
      }
      var lb=el("text",{class:"xlbl",x:x,y:D.t+pH+22});
      if(m.isYear){
        lb.setAttribute("font-weight","600");
        lb.setAttribute("fill","var(--ink)");
      }
      lb.textContent=m.lab; svg.appendChild(lb);
    });
    // Draw stock split indicators
    STOCK_SPLITS.forEach(function(split){
      var splitTs = new Date(split.date).getTime();
      if(splitTs < chartT0 || splitTs > chartT1) return; // Outside chart range
      var x = D.l + (splitTs - chartT0) / ((chartT1 - chartT0) || 1) * pW;
      // Draw vertical line
      svg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:D.t,y2:D.t+pH,"stroke-dasharray":"3 3",stroke:"rgba(233, 123, 164, 0.6)",opacity:"0.8"}));
    });
    var ends=[];
    selected.forEach(function(k){
      var s=byKey(k); if(!s) return;
      var col=colorOf(k), dsh=dashOf(k), dstr="", started=false;
      for(var i=0;i<n;i++){ if(!isInChartRange(i)) continue; var v=sval(s,i); if(v==null) continue;
        dstr+=(started?" L ":"M ")+X(i).toFixed(1)+" "+Y(v).toFixed(1); started=true; }
      if(dstr){ var pa={class:"serieline",d:dstr,stroke:col}; if(dsh) pa["stroke-dasharray"]=dsh;
        svg.appendChild(el("path",pa)); }
      /* A dashed line only reads as dashed if the dots stop filling in its gaps. At a
         couple of hundred closes the markers sit closer together than the dash itself and
         merge into a solid ribbon, hiding the one channel that tells slot 9 from slot 1.
         So a dashed series thins its markers to roughly one every 9px; the first eight,
         which carry a hue of their own, are untouched and still mark every point. */
      var every=1;
      if(dsh){ var vis=0; for(var c=0;c<n;c++) if(isInChartRange(c)&&sval(s,c)!=null) vis++;
               every=Math.max(1,Math.ceil(vis/Math.max(1,pW/9))); }
      var seen=0;
      for(var j=0;j<n;j++){ if(!isInChartRange(j)) continue; var vv=sval(s,j); if(vv==null) continue;
        if(seen++%every) continue;
        svg.appendChild(el("circle",{class:"dot",cx:X(j),cy:Y(vv),r:2.4,fill:col})); }
      if(s.qty) for(var b=0;b<n;b++) if(isBuyIdx(s.qty,b) && s.arr[b]!=null && isInChartRange(b))
        svg.appendChild(el("circle",{class:"buyring",cx:X(b),cy:Y(sval(s,b)),r:3.6,stroke:col}));
      var lv=sval(s,n-1);
      if(lv!=null) ends.push({y:Y(lv),col:col,txt:mode==="eur"?nfEur0.format(s.arr[n-1]):nfEur0.format(lv)});
    });
    ends.sort(function(a,b){return a.y-b.y;});
    for(var e=1;e<ends.length;e++) if(ends[e].y-ends[e-1].y<12) ends[e].y=ends[e-1].y+12;
    // Nudging each label down to clear the one above it runs the tail of a long stack off
    // the bottom of the chart — with sixteen series the last values were simply cut off.
    // Pin the lowest one to the axis and walk back up, which moves only the labels that
    // are actually in each other's way and leaves the rest beside their own line.
    if(ends.length && ends[ends.length-1].y>D.t+pH){
      ends[ends.length-1].y=D.t+pH;
      for(var u=ends.length-2;u>=0;u--) if(ends[u+1].y-ends[u].y<12) ends[u].y=ends[u+1].y-12;
    }
    ends.forEach(function(en){ var lb=el("text",{class:"endlbl",x:D.w-D.r+10,y:en.y+3.5,fill:en.col}); lb.textContent=en.txt; svg.appendChild(lb); });
    svg.appendChild(el("line",{class:"crosshair",id:"cross",x1:0,x2:0,y1:D.t,y2:D.t+pH,opacity:0}));
    svg.appendChild(el("g",{id:"fdots",opacity:0}));
    svg.appendChild(el("rect",{id:"hit",x:D.l,y:D.t,width:pW,height:pH,fill:"transparent"}));
    renderLegend();
  }
  function renderLegend(){
    var lg=document.getElementById("legend"); lg.innerHTML="";
    if(!n){ lg.innerHTML=""; return; }
    if(!selected.length){ lg.innerHTML='<span style="font-size:12.5px;color:var(--faint)">Pick a series above to plot it</span>'; return; }
    selected.forEach(function(k){
      var s=byKey(k); if(!s) return;
      var b=document.createElement("button");
      b.innerHTML='<i style="'+swatchCSS(k)+'"></i>'+esc(s.name)+' \u00d7';
      b.addEventListener("click",function(){ toggle(k); });
      lg.appendChild(b);
    });
  }
  function renderEventsTimeline(){
    var timeline=document.getElementById("events-timeline");
    // a split in a stock you do not own is not an event in your portfolio
    if(!n || !STOCK_SPLITS || STOCK_SPLITS.length===0){ timeline.innerHTML=""; return; }
    var sorted=STOCK_SPLITS.slice().sort(function(a,b){
      return new Date(a.date).getTime()-new Date(b.date).getTime();
    });
    var html='<div style="margin-top:8px"><b style="color:var(--ink);font-size:11px;letter-spacing:.08em;text-transform:uppercase">Events:</b><div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px">';
    sorted.forEach(function(split){
      var date=new Date(split.date).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
      html+='<span><b>'+date+'</b> \u00b7 '+split.ticker+' \u00b7 '+split.description+'</span>';
    });
    html+='</div></div>';
    timeline.innerHTML=html;
  }
  function renderPicker(){
    if(!ALL) return;
    syncSlots();
    var p=document.getElementById("picker"); p.innerHTML="";
    var acts=document.querySelector(".picker-actions");
    if(acts) acts.hidden=!n;
    if(!n) return;
    ALL.forEach(function(s){
      var on=selected.indexOf(s.key)>-1;
      var b=document.createElement("button");
      b.className="chip"+(s.agg?" agg":"");
      b.setAttribute("aria-pressed",on?"true":"false");
      b.innerHTML='<i class="sw" style="'+(on?swatchCSS(s.key):"background:transparent")+'"></i>'+esc(s.name);
      b.addEventListener("click",function(){ toggle(s.key); });
      p.appendChild(b);
    });
  }
  function toggle(k){
    var i=selected.indexOf(k);
    if(i>-1) selected.splice(i,1);
    else{
      if(selected.length>=CAP){
        var h=document.getElementById("caphint"); h.hidden=false;
        clearTimeout(capTimer); capTimer=setTimeout(function(){ h.hidden=selected.length<CAP; },2400);
        return;
      }
      selected.push(k);
    }
    document.getElementById("caphint").hidden=selected.length<CAP;
    hideMain(); renderPicker(); renderMain();
  }
  if(document.getElementById("fr-go")) document.getElementById("fr-go").addEventListener("click",goToFirstTransaction);
  document.getElementById("q-agg").addEventListener("click",function(){ selected=["_total","_tesla","_ex"]; document.getElementById("caphint").hidden=true; hideMain(); renderPicker(); renderMain(); });
  document.getElementById("q-clear").addEventListener("click",function(){ selected=[]; document.getElementById("caphint").hidden=true; hideMain(); renderPicker(); renderMain(); });
  function nearMain(cx){
    var r=svg.getBoundingClientRect(), px=(cx-r.left)/r.width*D.w, best=0, bd=1e9;
    for(var i=0;i<n;i++){ var dd=Math.abs(X(i)-px); if(dd<bd){bd=dd;best=i;} }
    return best;
  }
  function showMain(i){
    if(!selected.length) return;
    var x=X(i);
    var c=document.getElementById("cross"); c.setAttribute("x1",x); c.setAttribute("x2",x); c.setAttribute("opacity",1);
    var g=document.getElementById("fdots"); while(g.firstChild) g.removeChild(g.firstChild); g.setAttribute("opacity",1);
    var rows="", yref=null;
    selected.forEach(function(k){
      var s=byKey(k); if(!s) return;
      var v=sval(s,i);
      if(v!=null){ g.appendChild(el("circle",{class:"focus-dot",r:4,fill:colorOf(k),cx:x,cy:Y(v)})); if(yref==null) yref=Y(v); }
      var disp=v==null?"\u2014":(mode==="eur"?eur(s.arr[i]):usd(v));
      var qsh=(s.qty&&s.qty[i]!=null)?' <span class="qsh">'+s.qty[i]+' sh</span>':'';
      rows+='<div class="row"><span class="lab"><i style="'+swatchCSS(k)+'"></i>'+s.name+qsh+'</span><span class="v">'+disp+'</span></div>';
    });
    tip.innerHTML='<div class="th">'+SNAP[i].label+(SNAP[i].src&&SNAP[i].src!=="base"?' &middot; added':'')+'</div>'+rows;
    tip.classList.add("on");
    if(yref==null) yref=D.t;
    var relX=x/D.w*box.clientWidth, tw=tip.offsetWidth;
    tip.style.left=Math.max(tw/2+4,Math.min(box.clientWidth-tw/2-4,relX))+"px";
    tip.style.top=(yref/D.h*box.clientHeight-tip.offsetHeight-14)+"px";
  }
  function hideMain(){
    tip.classList.remove("on");
    var c=document.getElementById("cross"); if(c) c.setAttribute("opacity",0);
    var g=document.getElementById("fdots"); if(g){ while(g.firstChild) g.removeChild(g.firstChild); g.setAttribute("opacity",0); }
  }
  svg.addEventListener("pointermove",function(e){ showMain(nearMain(e.clientX)); });
  svg.addEventListener("pointerdown",function(e){ showMain(nearMain(e.clientX)); });
  svg.addEventListener("pointerleave",hideMain);
  document.getElementById("m-eur").addEventListener("click",function(){ setMode("eur"); });
  document.getElementById("m-usd").addEventListener("click",function(){ setMode("usd"); });
  function setMode(m){
    mode=m;
    document.getElementById("m-eur").setAttribute("aria-pressed",m==="eur");
    document.getElementById("m-usd").setAttribute("aria-pressed",m==="usd");
    hideMain(); renderMain();
  }

  // Time period buttons
  ["1m","3m","6m","1y","3y","5y","all"].forEach(function(p){
    var btn=document.getElementById("period-"+p);
    if(btn) btn.addEventListener("click",function(){
      timePeriod=p;
      document.querySelectorAll("[id^='period-']").forEach(function(b){ b.style.color="var(--muted)"; b.style.fontWeight="400"; });
      btn.style.color="var(--accent)";
      btn.style.fontWeight="600";
      hideMain(); renderMain();
    });
  });
  document.getElementById("period-all").click();
  if(window.matchMedia){
    var mq=window.matchMedia("(prefers-color-scheme: dark)");
    var onTheme=function(){ renderPicker(); renderMain(); };
    if(mq.addEventListener) mq.addEventListener("change",onTheme); else if(mq.addListener) mq.addListener(onTheme);
  }

  /* ================= VIEW 3 : indicators ================= */
  /* The first snapshot in which a holding was actually held: every per-stock
     figure below measures from there, not from the start of the portfolio, or a
     stock bought last month would show the whole period's move as its own. */
  function firstIdx(s){ for(var i=0;i<n;i++) if(s.vals[i]!=null) return i; return 0; }

  function renderPortfolioDetail(){
    if(!n){
      emptyKpiStrip();
      document.getElementById("detail-kpi").innerHTML="";
      drawEmptyChart(document.getElementById("g-iv"),"What you put in against what it is worth \u2014 the gap between the two lines is your gain. Both start once you register a transaction.",true);
      drawEmptyChart(document.getElementById("g-uw"),"How far the portfolio sits below its own previous peak. Flat at zero means a new high.",false);
      ["bars-weight","bars-contrib"].forEach(function(id){ var b=document.getElementById(id); if(b) b.innerHTML=""; });
      return;
    }
    if(!GROWTH||!INVESTED) return;
    clearEmptyChart(document.getElementById("g-iv"));
    clearEmptyChart(document.getElementById("g-uw"));
    var g=GROWTH;
    var nowTot=TOTAL[n-1], t0=TOTAL[0], winRet=nowTot/t0-1;
    var peak=-1,pk=0,trough=1e18,tr=0,rp=-1,rpi=0,mdd=0,mp=0,mt=0;
    TOTAL.forEach(function(v,i){
      if(v>peak){peak=v;pk=i;} if(v<trough){trough=v;tr=i;}
      if(v>rp){rp=v;rpi=i;} var dd=v/rp-1; if(dd<mdd){mdd=dd;mp=rpi;mt=i;}
    });
    var mv=[]; for(var q=1;q<n;q++) mv.push(TOTAL[q]/TOTAL[q-1]-1);
    var mean=mv.reduce(function(a,b){return a+b;},0)/mv.length;
    var sd=Math.sqrt(mv.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/mv.length);
    var bi=0,wi=0; mv.forEach(function(m,i){ if(m>mv[bi])bi=i; if(m<mv[wi])wi=i; });

    var per=UNI.map(function(s){
      var f=firstIdx(s); if(s.vals[n-1]==null) return null;
      var qf=s.qty[f]||1, ql=s.qty[n-1]||qf;
      var pxF=s.vals[f]/qf, pxL=s.vals[n-1]/ql;
      return {name:s.name,short:s.short,w:s.vals[n-1]/nowTot,val:s.vals[n-1],
        dVal:s.vals[n-1]-s.vals[f],dValP:s.vals[n-1]/s.vals[f]-1,dPx:pxL/pxF-1,
        rent:s.rentLatest,cost:s.rentLatest!=null?s.vals[n-1]/(1+s.rentLatest/100):null};
    }).filter(Boolean);
    var withRent=per.filter(function(p){return p.cost!=null;});
    var costSum=withRent.reduce(function(a,p){return a+p.cost;},0);
    var rentVal=withRent.reduce(function(a,p){return a+p.val;},0);
    var hhi=per.reduce(function(a,p){return a+p.w*p.w;},0);
    var upN=per.filter(function(p){return p.dPx>0;}).length;
    var top=per.slice().sort(function(a,b){return b.w-a.w;});
    var top3=(top[0]?top[0].val:0)+(top[1]?top[1].val:0)+(top[2]?top[2].val:0);
    var lift=per.slice().sort(function(a,b){return b.dVal-a.dVal;})[0];
    var drag=per.slice().sort(function(a,b){return a.dVal-b.dVal;})[0];
    var days=(T1-T0)/864e5, ann=Math.pow(1+winRet,365/Math.max(days,1))-1;

    function dd2(i){ return SNAP[i].label.replace(/,.*$/,""); }
    // one day of history means there is no "next" snapshot to name
    function gap(i){ return SNAP[i+1] ? dd2(i)+" \u2192 "+dd2(i+1) : dd2(i); }
    function kpi(k){ return '<div class="kpi"><div class="k-label">'+k.l+'</div><div class="k-val">'+k.v+'</div>'+(k.s?'<div class="k-sub '+(k.c||"")+'">'+k.s+'</div>':'')+'</div>'; }

    var addedNote = userEntries.length ? " · incl. "+userEntries.length+" you added" : "";
    var strip=[
      {l:"Current value", v:eur(nowTot)},
      {l:"Since "+shortDate(T0), v:dp(winRet), s:d0(nowTot-t0)+addedNote, c:winRet>=0?"pos":"neg"},
      {l:"Peak value", v:"\u20ac "+nfEur0.format(peak), s:dd2(pk)},
      {l:"Lowest value", v:"\u20ac "+nfEur0.format(trough), s:dd2(tr)},
      {l:"Max drawdown", v:dp(mdd), s:dd2(mp)+" \u2192 "+dd2(mt), c:"neg"}
    ];
    document.getElementById("kpi-strip").innerHTML=strip.map(kpi).join("");
    document.getElementById("detail-kpi").innerHTML=[
      {l:"Market value", v:eur(nowTot), s:fmtDayY.format(new Date(T1))},
      {l:"Invested (cost basis)", v:"\u20ac "+nfEur0.format(g.invEnd), s:"estimated, from the return % column"},
      {l:"Total gain", v:d0(g.gain), s:dp(g.gainPct)+" on cost", c:g.gain>=0?"pos":"neg"},
      strip[1],
      {l:"Return on picks", v:dp(g.twr), s:"time-weighted, deposits removed", c:g.twr>=0?"pos":"neg"},
      {l:"Return on picks / yr", v:dp(g.twrAnn)+"/yr", s:"annualised over "+g.years.toFixed(1)+" yrs", c:g.twrAnn>=0?"pos":"neg"},
      {l:"Capital added", v:d0(g.added), s:"since "+shortDate(T0)},
      strip[2],strip[3],strip[4],
      {l:"Now vs peak", v:dp(nowTot/peak-1), c:nowTot>=peak?"pos":"neg", s:"clawed back "+d0(nowTot-trough)+" off the low"},
      {l:"Snapshot-to-snapshot swing", v:"\u00b1"+comma((sd*100).toFixed(1))+"%", s:"std dev of the "+mv.length+" gaps"},
      {l:"Best / worst gap", v:mv.length?dp(mv[bi])+" / "+dp(mv[wi]):"\u2014",
       s:mv.length?gap(bi)+"  \u00b7  "+gap(wi):"needs more than one day of history"},
      {l:"Concentration", v:(top[0]?Math.round(top[0].w*100):0)+"% "+(top[0]?top[0].short:""), s:"top 3 = "+Math.round(top3/nowTot*100)+"%  \u00b7  effective "+comma((1/hhi).toFixed(1))+" of "+per.length},
      {l:"Breadth", v:upN+" up \u00b7 "+(per.length-upN)+" down", s:"per-share price over the window"},
      {l:"Biggest lift / drag", v:(lift?lift.short:"")+" / "+(drag?drag.short:""), s:(lift?d0(lift.dVal):"")+"  \u00b7  "+(drag?d0(drag.dVal):"")+" in value"},
      withRent.length?{l:"Est. unrealised return", v:dp(rentVal/costSum-1), c:"pos", s:"all-time \u00b7 ~"+d0(rentVal-costSum)+" on ~\u20ac"+nfEur0.format(costSum)+" cost"+(withRent.length<per.length?" ("+withRent.length+"/"+per.length+" names)":"")}
        :{l:"Est. unrealised return", v:"\u2014", s:"add a Ret.% on a snapshot to enable"},
      {l:"At this pace", v:dp(ann)+"/yr", c:ann>=0?"pos":"neg", s:"annualised "+Math.round(days)+"-day window \u00b7 distorted by deposits"},
      {l:"Deepest drawdown", v:dp(g.ddMin), s:"now "+dp(g.ddNow), c:"neg"}
    ].map(kpi).join("");

    document.getElementById("ind-h1").textContent="Weight of each holding \u00b7 "+fmtDayY.format(new Date(T1));

    // Render clean pie chart for portfolio allocation
    var pieContainer=document.getElementById("bars-weight");
    var sorted=per.slice().sort(function(a,b){return b.w-a.w;});
    var svgW=600, svgH=600, cx=300, cy=300, r=200;
    var svg='<div style="display:flex;gap:12px;align-items:center;margin-bottom:16px"><div style="position:relative;flex-shrink:0"><svg viewBox="0 0 '+svgW+' '+svgH+'" style="width:600px;height:600px;cursor:pointer" id="pie-chart" role="img" aria-label="Portfolio allocation pie chart">';
    svg+='<defs><style>.pie-slice{transition:all 0.15s;cursor:pointer}.pie-slice:hover{filter:brightness(1.1);stroke-width:3!important}</style></defs>';
    var angle=-Math.PI/2;
    var colors=palette();
    sorted.forEach(function(p,i){
      var sliceAngle=p.w*2*Math.PI;
      var x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
      var x2=cx+r*Math.cos(angle+sliceAngle), y2=cy+r*Math.sin(angle+sliceAngle);
      var large=sliceAngle>Math.PI?1:0;
      var path='M '+cx+' '+cy+' L '+x1.toFixed(1)+' '+y1.toFixed(1)+' A '+r+' '+r+' 0 '+large+' 1 '+x2.toFixed(1)+' '+y2.toFixed(1)+' Z';
      svg+='<g class="pie-group" data-ticker="'+esc(p.short)+'" data-pct="'+comma((p.w*100).toFixed(1))+'" data-val="'+nfEur2.format(p.val)+'">';
      svg+='<path class="pie-slice" d="'+path+'" fill="'+colors[i%8]+'" stroke="var(--surface)" stroke-width="3"/>';
      svg+='</g>';
      angle+=sliceAngle;
    });
    svg+='<circle cx="'+cx+'" cy="'+cy+'" r="120" fill="var(--surface)" stroke="var(--hair)" stroke-width="1"/>';
    svg+='<text x="'+cx+'" y="'+cy+'" text-anchor="middle" dy="0.3em" style="font-size:28px;font-weight:600;fill:var(--ink)">'+per.length+'</text>';
    svg+='<text x="'+cx+'" y="'+(cy+32)+'" text-anchor="middle" style="font-size:13px;fill:var(--faint)">holdings</text>';
    svg+='</svg><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;z-index:10;background:var(--surface);border:1px solid var(--hair);border-radius:8px;padding:10px 14px;box-shadow:var(--shadow);white-space:nowrap" id="pie-tip" hidden><div style="font-weight:600;font-size:13px;color:var(--ink)" id="pie-tip-ticker"></div><div style="font-size:12px;color:var(--muted);margin-top:4px"><span id="pie-tip-pct"></span>%</div><div style="font-size:12px;color:var(--muted)">\u20ac<span id="pie-tip-val"></span></div></div></div>';

    svg+='<div style="width:160px;display:flex;flex-direction:column;gap:4px">';
    sorted.forEach(function(p,i){
      svg+='<div style="font-size:11px;padding:6px 8px;border-radius:4px;background:var(--surface-2);border-left:3px solid '+colors[i%8]+';text-align:right"><div style="font-weight:500;color:var(--ink)">'+esc(p.short)+'</div><div style="font-size:9px;color:var(--muted)">'+comma((p.w*100).toFixed(1))+'% \u00b7 \u20ac'+nfEur2.format(p.val)+'</div></div>';
    });
    svg+='</div></div>';

    pieContainer.innerHTML=svg;

    // Add hover handlers
    document.querySelectorAll(".pie-group").forEach(function(g){
      g.addEventListener("mouseenter",function(){
        var tip=document.getElementById("pie-tip");
        document.getElementById("pie-tip-ticker").textContent=g.dataset.ticker;
        document.getElementById("pie-tip-val").textContent=g.dataset.val;
        document.getElementById("pie-tip-pct").textContent=g.dataset.pct;
        tip.hidden=false;
      });
      g.addEventListener("mouseleave",function(){
        document.getElementById("pie-tip").hidden=true;
      });
    });
    var cmax=Math.max.apply(null,per.map(function(p){return Math.abs(p.dVal);}))||1;
    document.getElementById("bars-contrib").innerHTML=per.slice().sort(function(a,b){return b.dVal-a.dVal;}).map(function(p){
      var w=(Math.abs(p.dVal)/cmax*50).toFixed(1);
      var st=p.dVal>=0?"left:50%;width:"+w+"%":"right:50%;width:"+w+"%";
      return '<div class="hrow div"><span class="hl">'+esc(p.short)+'</span><span class="ht"><span class="hmid"></span><span class="hf '+(p.dVal>=0?"pos":"neg")+'" style="'+st+'"></span></span><span class="hv">'+d0(p.dVal)+'</span></div>';
    }).join("");
    document.getElementById("ind-table").innerHTML=
      '<thead><tr><th>Stock</th><th>Weight</th><th>Value</th><th>&Delta; value</th><th>&Delta; value %</th><th>&Delta; price/sh %</th><th>Unreal. %</th></tr></thead><tbody>'+
      per.slice().sort(function(a,b){return b.val-a.val;}).map(function(p){
        return '<tr><td>'+p.name+'</td><td>'+comma((p.w*100).toFixed(1))+'%</td><td>'+nfEur2.format(p.val)+'</td><td>'+d0(p.dVal)+'</td><td>'+dp(p.dValP)+'</td><td>'+dp(p.dPx)+'</td><td>'+(p.rent!=null?dp(p.rent/100):"\u2014")+'</td></tr>';
      }).join("")+'</tbody>';
    /* --- invested vs value --- */
    var svg=document.getElementById("g-iv");
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    var W=960,H=430,l=66,r=108,tp=22,bt=40, pW=W-l-r, pH=H-tp-bt, box=svg.parentNode;
    var vmax=Math.max.apply(null,TOTAL.filter(function(x){return x!=null;}));
    var tks=niceTicks(0,vmax,5), yhi=tks[tks.length-1];
    function X(i){ return l+(T[i]-T0)/((T1-T0)||1)*pW; }
    function Y(v){ return tp+(1-v/yhi)*pH; }
    tks.forEach(function(t){ var y=Y(t);
      svg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5}); lb.textContent=nfEur0.format(t); svg.appendChild(lb);
    });
    monthTicks().forEach(function(m){ var x=l+(m.t-T0)/((T1-T0)||1)*pW;
      svg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:tp,y2:tp+pH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:tp+pH+22}); lb.textContent=m.lab; svg.appendChild(lb);
    });
    var pv="", pi="", band="M ";
    for(var i=0;i<n;i++){
      pv+=(i?" L ":"M ")+X(i).toFixed(1)+" "+Y(TOTAL[i]).toFixed(1);
      pi+=(i?" L ":"M ")+X(i).toFixed(1)+" "+Y(INVESTED[i]).toFixed(1);
      band+=(i?" L ":"")+X(i).toFixed(1)+" "+Y(TOTAL[i]).toFixed(1);
    }
    for(var i=n-1;i>=0;i--){ band+=" L "+X(i).toFixed(1)+" "+Y(INVESTED[i]).toFixed(1); }
    band+=" Z";
    svg.appendChild(el("path",{class:"iv-band",d:band}));
    svg.appendChild(el("path",{class:"serieline",d:pi,stroke:"var(--muted)"}));
    svg.appendChild(el("path",{class:"serieline",d:pv,stroke:"var(--accent)"}));
    var eV=el("text",{class:"endlbl",x:W-r+8,y:Y(TOTAL[n-1])+3.5,fill:"var(--accent)"}); eV.textContent="Value "+nfEur0.format(TOTAL[n-1]); svg.appendChild(eV);
    var eI=el("text",{class:"endlbl",x:W-r+8,y:Y(INVESTED[n-1])+3.5,fill:"var(--muted)"}); eI.textContent="Invested "+nfEur0.format(INVESTED[n-1]); svg.appendChild(eI);
    var cross=el("line",{class:"crosshair",x1:0,x2:0,y1:tp,y2:tp+pH,opacity:0}); svg.appendChild(cross);
    var gd=el("g",{opacity:0});
    gd.appendChild(el("circle",{class:"focus-dot",r:4,fill:"var(--accent)"}));
    gd.appendChild(el("circle",{class:"focus-dot",r:4,fill:"var(--muted)"}));
    svg.appendChild(gd);
    svg.appendChild(el("rect",{x:l,y:tp,width:pW,height:pH,fill:"transparent"}));
    var tip=document.getElementById("g-tip");
    function near(cx){ var rr=svg.getBoundingClientRect(), px=(cx-rr.left)/rr.width*W, b=0,bd=1e9; for(var i=0;i<n;i++){var d=Math.abs(X(i)-px); if(d<bd){bd=d;b=i;}} return b; }
    function show(i){
      var x=X(i);
      cross.setAttribute("x1",x); cross.setAttribute("x2",x); cross.setAttribute("opacity",1);
      gd.setAttribute("opacity",1);
      gd.childNodes[0].setAttribute("cx",x); gd.childNodes[0].setAttribute("cy",Y(TOTAL[i]));
      gd.childNodes[1].setAttribute("cx",x); gd.childNodes[1].setAttribute("cy",Y(INVESTED[i]));
      var gg=TOTAL[i]-INVESTED[i];
      tip.innerHTML='<div class="th">'+SNAP[i].label.replace(/,.*$/,"")+'</div>'+
        '<div class="row"><span class="lab"><i style="background:var(--accent)"></i>Value</span><span class="v">'+eur(TOTAL[i])+'</span></div>'+
        '<div class="row"><span class="lab"><i style="background:var(--muted)"></i>Invested</span><span class="v">'+eur(INVESTED[i])+'</span></div>'+
        '<div class="row"><span class="lab">Gain</span><span class="v">'+d0(gg)+' &middot; '+dp(gg/INVESTED[i])+'</span></div>';
      tip.classList.add("on");
      var relX=x/W*box.clientWidth, tw=tip.offsetWidth;
      tip.style.left=Math.max(tw/2+4,Math.min(box.clientWidth-tw/2-4,relX))+"px";
      tip.style.top=(Y(TOTAL[i])/H*box.clientHeight-tip.offsetHeight-12)+"px";
    }
    function hide(){ tip.classList.remove("on"); cross.setAttribute("opacity",0); gd.setAttribute("opacity",0); }
    svg.onpointermove=function(e){ show(near(e.clientX)); };
    svg.onpointerdown=function(e){ show(near(e.clientX)); };
    svg.onpointerleave=hide;

    /* --- underwater --- */
    var uw=document.getElementById("g-uw");
    while(uw.firstChild) uw.removeChild(uw.firstChild);
    var UW=960,UHt=300,ul=66,urt=108,utp=20,ubt=34, upW=UW-ul-urt, upH=UHt-utp-ubt;
    var dmin=Math.min(-0.02, g.ddMin*1.08), stepd=Math.abs(dmin)>0.32?0.1:0.05;
    function UX(i){ return ul+(T[i]-T0)/((T1-T0)||1)*upW; }
    function UY(v){ return utp+(1-(v-dmin)/(0-dmin))*upH; }
    for(var t=0;t>=dmin-1e-9;t-=stepd){ var y=UY(t);
      uw.appendChild(el("line",{class:"gridline",x1:ul,x2:UW-urt,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:ul-10,y:y+3.5}); lb.textContent=Math.round(t*100)+"%"; uw.appendChild(lb);
    }
    monthTicks().forEach(function(m){ var x=ul+(m.t-T0)/((T1-T0)||1)*upW;
      uw.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:utp,y2:utp+upH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:utp+upH+20}); lb.textContent=m.lab; uw.appendChild(lb);
    });
    var dl="";
    for(var i=0;i<n;i++){ dl+=(i?" L ":"M ")+UX(i).toFixed(1)+" "+UY(DD[i]).toFixed(1); }
    uw.appendChild(el("path",{class:"uw-area",d:"M "+UX(0).toFixed(1)+" "+UY(0).toFixed(1)+" L "+dl.slice(2)+" L "+UX(n-1).toFixed(1)+" "+UY(0).toFixed(1)+" Z"}));
    uw.appendChild(el("path",{class:"uw-line",d:dl}));
    var di=0; for(var i=0;i<n;i++) if(DD[i]<DD[di]) di=i;
    uw.appendChild(el("circle",{cx:UX(di),cy:UY(DD[di]),r:3.5,fill:"var(--neg)",stroke:"var(--surface)","stroke-width":1.5}));
    var dLab=el("text",{class:"endlbl","text-anchor":di>n*0.85?"end":(di<n*0.15?"start":"middle"),x:UX(di),y:UY(DD[di])+18,fill:"var(--neg)"});
    dLab.textContent=dp(DD[di])+" · "+shortDate(T[di]); uw.appendChild(dLab);
    var nLab=el("text",{class:"endlbl",x:UW-urt+8,y:UY(DD[n-1])+3.5,fill:"var(--neg)"}); nLab.textContent="now "+dp(DD[n-1]); uw.appendChild(nLab);
  }

  /* ================= data table ================= */
  var tableMode="amt";
  function renderTable(){
    var qtyMode=tableMode==="qty";
    document.getElementById("th-row").innerHTML='<th>Snapshot</th>'+UNI.map(function(s){return '<th>'+esc(s.short)+'</th>';}).join("")+'<th>'+(qtyMode?'Positions':'Total')+'</th>';
    var tb=document.getElementById("tbody"); tb.innerHTML="";
    for(var r=0;r<n;r++){
      var tr=document.createElement("tr");
      if(SNAP[r].src&&SNAP[r].src!=="base") tr.className="urow";
      var cells='<td>'+SNAP[r].label.replace(", "," \u00b7 ")+'</td>';
      var held=0;
      for(var c=0;c<UNI.length;c++){
        var v=UNI[c].vals[r], q=UNI[c].qty[r];
        if(v!=null) held++;
        var cellContent;
        if(qtyMode){
          cellContent=q==null?"\u2014":q;
        } else {
          if(v==null){
            cellContent="\u2014";
          } else {
            // Get currency for this ticker
            var ticker=UNI[c].key.toUpperCase();
            var currency=TICKER_CURRENCY[ticker]||"EUR";
            if(currency==="USD"){
              var rate=TICKER_EXCHANGE_RATE[ticker]||1.087;
              cellContent="$\u00a0"+nfEur2.format(v/rate);
            } else {
              cellContent="\u20ac\u00a0"+nfEur2.format(v);
            }
          }
        }
        cells+='<td>'+cellContent+'</td>';
      }
      cells+='<td>'+(qtyMode ? held : (TOTAL[r]==null?"\u2014":"\u20ac\u00a0"+nfEur2.format(TOTAL[r])))+'</td>';
      tr.innerHTML=cells; tb.appendChild(tr);
    }
  }
  // Table collapse/expand
  var tableCollapsed=true;
  function toggleTableCollapse(){
    tableCollapsed=!tableCollapsed;
    var content=document.getElementById("table-content");
    var section=document.getElementById("table-section");
    var header=document.getElementById("table-header");
    var btn=document.getElementById("table-toggle");
    content.style.display=tableCollapsed?"none":"block";
    section.style.opacity=tableCollapsed?"0.6":"1";
    btn.style.transform=tableCollapsed?"":"rotate(180deg)";
    header.style.background=tableCollapsed?"":"rgba(255,255,255,0.03)";
  }
  document.getElementById("table-header").addEventListener("click",toggleTableCollapse);

  // Notes collapse/expand
  var notesCollapsed=true;
  function toggleNotesCollapse(){
    notesCollapsed=!notesCollapsed;
    var content=document.getElementById("notes-content");
    var section=document.getElementById("notes-section");
    var header=document.getElementById("notes-header");
    var btn=document.getElementById("notes-toggle");
    content.style.display=notesCollapsed?"none":"block";
    section.style.opacity=notesCollapsed?"0.6":"1";
    btn.style.transform=notesCollapsed?"":"rotate(180deg)";
    header.style.background=notesCollapsed?"":"rgba(255,255,255,0.03)";
  }
  document.getElementById("notes-header").addEventListener("click",toggleNotesCollapse);

  document.getElementById("t-amt").addEventListener("click",function(){ tableMode="amt"; this.setAttribute("aria-pressed","true"); document.getElementById("t-qty").setAttribute("aria-pressed","false"); renderTable(); });
  document.getElementById("t-qty").addEventListener("click",function(){ tableMode="qty"; this.setAttribute("aria-pressed","true"); document.getElementById("t-amt").setAttribute("aria-pressed","false"); renderTable(); });


  /* ================= ALGORITHM (position-timing signal) ================= */
  var ALGO_CACHE={}, algoSelected=null, ALGO=null;

  var ALGO_LANE_TEXT={
    early:"Early — Sell needs two of the three windows to read High. Buy needs only one, because a real dip shows up in the 6-month window first, while the 1- and 2-year windows are still anchored to the prior run-up.",
    confirmed:"Confirmed — the same Sell rule, but Buy now needs two windows to agree as well. Slower, and it misses early pullbacks the other lane catches.",
    events:"Events — a green mark is an email this algorithm sent you about this holding. A grey mark is a change you made to its timings, which applies to every holding at once. Both are here so a gap in the emails can be read against the rules that were in force at the time."
  };

  function algoSym(cur){ return cur==="EUR"?"€":cur==="USD"?"$":cur==="GBP"?"£":(cur+" "); }
  function algoMoney(v,cur){ return algoSym(cur)+comma(Number(v).toFixed(2)); }
  function algoDate(d){
    var m=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var p=String(d).split("-"); return p[2].replace(/^0/,"")+" "+m[+p[1]-1]+" "+p[0];
  }
  function algoPct(v){ return comma(Number(v).toFixed(1)); }
  function algoDirClass(dir){ return dir==="Buy"?"buy":dir==="Sell"?"sell":"none"; }
  function algoTierWord(t){ return t==="VeryStrong"?"Very strong":t||""; }


  /* ---- the two timings the user owns ---- */
  var ALGO_HOLD_OPTS=[{v:1,l:"1 day"},{v:2,l:"2 days"},{v:3,l:"3 days"},{v:5,l:"5 days"},{v:10,l:"10 days"}];
  var ALGO_COOL_OPTS=[{v:14,l:"2 weeks"},{v:30,l:"1 month"},{v:60,l:"2 months"},{v:90,l:"3 months"},{v:180,l:"6 months"}];
  var ALGO_CFG=null;

  function loadAlgoSettings(){
    if(ALGO_CFG){ renderAlgoSettings(); return Promise.resolve(); }
    return apiFetch('./api/algorithm/settings')
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(cfg){ if(cfg){ ALGO_CFG=cfg; renderAlgoSettings(); } })
      .catch(function(){});
  }

  function renderAlgoSettings(){
    if(!ALGO_CFG) return;
    function paint(id,opts,current,onPick){
      var el=document.getElementById(id); if(!el) return;
      el.innerHTML=opts.map(function(o){
        return '<button type="button" data-v="'+o.v+'" aria-pressed="'+(o.v===current?"true":"false")+'">'+esc(o.l)+'</button>';
      }).join("");
      Array.prototype.forEach.call(el.querySelectorAll("button"),function(b){
        b.addEventListener("click",function(){ onPick(parseInt(b.dataset.v,10)); });
      });
    }
    paint("algo-hold-presets",ALGO_HOLD_OPTS,ALGO_CFG.holdDays,function(v){ saveAlgoSettings(v,ALGO_CFG.cooldownDays); });
    paint("algo-cool-presets",ALGO_COOL_OPTS,ALGO_CFG.cooldownDays,function(v){ saveAlgoSettings(ALGO_CFG.holdDays,v); });
    describeAlgoSettings();
  }

  function describeAlgoSettings(){
    var note=document.getElementById("algo-cfg-note"); if(!note||!ALGO_CFG) return;
    var cool=ALGO_COOL_OPTS.filter(function(o){ return o.v===ALGO_CFG.cooldownDays; })[0];
    note.innerHTML="A holding has to read very strong buy on <b>"+ALGO_CFG.holdDays+
      (ALGO_CFG.holdDays===1?" day":" days in a row")+"</b>, and then goes unmentioned for <b>"+
      esc(cool?cool.l:ALGO_CFG.cooldownDays+" days")+"</b>.";
  }

  function saveAlgoSettings(hold,cool){
    var note=document.getElementById("algo-cfg-note");
    if(note) note.textContent="Saving…";
    return apiFetch('./api/algorithm/settings',{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({holdDays:hold,cooldownDays:cool})})
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,body:j}; }); })
      .then(function(res){
        if(!res.ok){ if(note) note.textContent=res.body.error||"Could not save."; return; }
        ALGO_CFG.holdDays=res.body.holdDays; ALGO_CFG.cooldownDays=res.body.cooldownDays;
        renderAlgoSettings();
        toast("Alert timing saved","success");
      })
      .catch(function(){ if(note) note.textContent="Could not reach the server."; });
  }

  function loadAndRenderAlgo(){
    var ready=Object.keys(AVG_COST).length?Promise.resolve():loadAvgCostAndRuleForm();
    loadAlgoSettings();
    return ready.then(renderAlgoTickers);
  }

  function renderAlgoTickers(){
    var tickers=Object.keys(AVG_COST), wrap=document.getElementById("algo-tickers");
    if(!wrap) return Promise.resolve();
    if(!tickers.length){
      wrap.innerHTML='<span class="lbl" style="padding:6px 10px">Register a transaction first &mdash; this tab times the holdings you own</span>';
      document.getElementById("algo-note").innerHTML="";
      document.getElementById("algo-today").innerHTML="";
      document.getElementById("algo-kpi").innerHTML="";
      document.getElementById("algo-runs").innerHTML="";
      document.getElementById("algo-foot").innerHTML="";
      drawEmptyChart(document.getElementById("algo-chart"),"Each holding’s daily close, with the days the rules call Buy or Sell marked underneath.",true);
      return Promise.resolve();
    }
    if(!algoSelected||tickers.indexOf(algoSelected)===-1) algoSelected=tickers[0];
    wrap.innerHTML=tickers.map(function(t){
      return '<button data-ticker="'+esc(t)+'" aria-pressed="'+(t===algoSelected?"true":"false")+'">'+esc(tickerLabel(t))+'</button>';
    }).join("");
    Array.prototype.forEach.call(wrap.querySelectorAll("button"),function(b){
      b.addEventListener("click",function(){
        algoSelected=b.dataset.ticker;
        Array.prototype.forEach.call(wrap.querySelectorAll("button"),function(o){
          o.setAttribute("aria-pressed",o.dataset.ticker===algoSelected?"true":"false");
        });
        loadAlgo(algoSelected);
      });
    });
    return loadAlgo(algoSelected);
  }

  function algoMessage(html){
    document.getElementById("algo-note").innerHTML=html;
    document.getElementById("algo-today").innerHTML="";
    document.getElementById("algo-kpi").innerHTML="";
    document.getElementById("algo-runs").innerHTML="";
    document.getElementById("algo-foot").innerHTML="";
    document.getElementById("algo-table-holder").hidden=true;
    drawEmptyChart(document.getElementById("algo-chart"),"Nothing to rank against yet.",false);
  }

  function loadAlgo(t){
    if(ALGO_CACHE[t]){ ALGO=ALGO_CACHE[t]; renderAlgo(ALGO); return Promise.resolve(); }
    document.getElementById("algo-note").textContent="Ranking "+t+" against its own history…";
    return apiFetch('./api/algorithm?ticker='+encodeURIComponent(t)+'&period=2y')
      .then(function(r){ return r.json().then(function(j){ return {ok:r.ok,status:r.status,body:j}; }); })
      .then(function(res){
        if(!res.ok){
          if(res.status===409){
            algoMessage("Not enough price history for "+esc(t)+" yet. The longest window looks back two years, so every displayed day needs two full years behind it — run <code>node backfill-history.js "+esc(t)+" --years 5</code> to fill it in.");
          } else {
            algoMessage("Could not score "+esc(t)+": "+esc(res.body&&res.body.error||"unknown error"));
          }
          return;
        }
        ALGO_CACHE[t]=res.body; ALGO=res.body; renderAlgo(res.body);
      })
      .catch(function(){ algoMessage("Could not reach the server to score "+esc(t)+"."); });
  }

  function renderAlgo(d){
    clearEmptyChart(document.getElementById("algo-chart"));
    document.getElementById("algo-price").textContent=algoMoney(d.currentPrice,d.currency);
    document.getElementById("algo-asof").textContent="close of "+algoDate(d.asOf);

    var yrs=(d.days.length/252).toFixed(1);
    document.getElementById("algo-note").innerHTML="Showing "+d.days.length+" trading days ("+comma(yrs)+" years) to "+algoDate(d.asOf)+
      ". Every one of them has a full two years of history behind it — history reaches back to "+algoDate(d.meta.historyFrom)+".";

    renderAlgoToday(d);
    renderAlgoKpis(d);
    drawAlgoChart(d);
    renderAlgoRuns(d);
    renderAlgoTable(d);
    renderAlgoFoot(d);
  }

  function renderAlgoToday(d){
    var lane=d.today.early, cls=algoDirClass(lane.direction), g=d.gate;
    var call=lane.direction==="None"?"No signal today":lane.direction;
    var html='<div class="algo-today '+cls+'"><div class="algo-today-top">'+
      '<span class="algo-call '+cls+'">'+esc(call)+'</span>';
    if(lane.tier){
      // Same palette as the lane bars, so the badge and the strip agree at a glance.
      var tierCls={VeryStrong:"t-verystrong",Strong:"t-strong",Signal:"t-signal",Watch:"t-watch"}[lane.tier]||"t-watch";
      html+='<span class="algo-tier-badge '+cls+' '+tierCls+'">'+esc(algoTierWord(lane.tier))+' · '+Math.round(lane.confidencePct)+'%</span>';
    }
    html+='<span class="algo-tier">Confirmed lane: '+esc(d.today.confirmed.direction==="None"?"silent":d.today.confirmed.direction)+'</span>';
    if(g&&g.applicable&&(lane.direction==="Buy"||lane.direction==="Sell")){
      html+='<span class="algo-gate '+(g.gateMet?"met":"unmet")+'">'+(g.gateMet?"Position agrees":"Position says wait")+'</span>';
    }
    html+='</div>';

    if(g&&g.applicable){
      var gp=Number(g.gainPct), up=gp>=0;
      var hold=' You hold '+comma(Number(d.position.shares).toFixed(Number(d.position.shares)%1?4:0))+
        ' at an average cost of €'+comma(Number(d.position.avgCost).toFixed(2))+'.';
      if(lane.direction==="None"){
        html+='<p>The price sits mid-range on every window, so there is nothing to act on.'+hold+'</p>';
      } else {
        // Built from the numbers rather than the server's sentence so the decimal
        // separator matches the rest of the app, which is European throughout.
        html+='<p><b>'+esc(g.action)+'</b> — you are '+(up?"up":"down")+' '+comma(Math.abs(gp).toFixed(1))+'% ('+d0(Number(g.gainAbs))+') on this holding, '+
          (g.gateMet?"past":"short of")+' the '+comma(Math.abs(Number(g.need)).toFixed(0))+'% you set before '+
          (lane.direction==="Sell"?"trimming":"adding")+'.'+hold+'</p>';
      }
    }

    html+='<div class="algo-regimes">'+d.meta.windows.map(function(w){
      var r=d.today.regimes[w.key], pr=d.today.percentiles[w.key];
      return '<span class="algo-rchip">'+esc(w.label)+' <b>'+esc(algoRegimeWord(r))+'</b> · '+algoPct(pr)+' pct</span>';
    }).join("")+'</div></div>';
    document.getElementById("algo-today").innerHTML=html;
  }

  function algoRegimeWord(r){
    return r==="StrongHigh"?"Strong high":r==="StrongLow"?"Strong low":r==="High"?"High":r==="Low"?"Low":"Neutral";
  }

  function renderAlgoKpis(d){
    function kpi(k){ return '<div class="kpi"><div class="k-label">'+k.l+'</div><div class="k-val">'+k.v+'</div>'+(k.s?'<div class="k-sub '+(k.c||"")+'">'+k.s+'</div>':'')+'</div>'; }
    var n=d.stats.totalDays, pctOf=function(x){ return comma((x/n*100).toFixed(0))+"% of the period"; };
    document.getElementById("algo-kpi").innerHTML=[
      {l:"Days in the sell zone", v:String(d.stats.sellDays), c:"neg", s:pctOf(d.stats.sellDays)},
      {l:"Days in the buy zone (early)", v:String(d.stats.buyDaysEarly), c:"pos", s:pctOf(d.stats.buyDaysEarly)},
      {l:"… of those, also confirmed", v:String(d.stats.buyDaysAlsoConfirmed), c:"pos", s:d.stats.buyDaysEarly?comma((d.stats.buyDaysAlsoConfirmed/d.stats.buyDaysEarly*100).toFixed(0))+"% of the early buys":"no early buys"},
      {l:"Days with no signal", v:String(d.stats.noSignalDays), s:pctOf(d.stats.noSignalDays)}
    ].map(kpi).join("");
  }

  /* ---- the chart: price line plus the two lane strips ---- */
  var ALGO_GEO=null;
  function drawAlgoChart(d){
    var days=d.days, n=days.length;
    var L=74,R=948,T=16,B=244;
    var LANE=[{key:"e",y:276,label:"Early"},{key:"f",y:300,label:"Confirmed"}], LH=14;
    var EVY=334;   // the events timeline, clear of the signal lanes above it
    var lo=Infinity,hi=-Infinity;
    days.forEach(function(x){ if(x.close<lo)lo=x.close; if(x.close>hi)hi=x.close; });
    var pad=(hi-lo)*0.06||1; lo-=pad; hi+=pad;
    var X=function(i){ return L+(R-L)*(i+0.5)/n; };
    var Y=function(v){ return B-(B-T)*(v-lo)/(hi-lo); };
    var bw=Math.max((R-L)/n,0.8);
    ALGO_GEO={L:L,R:R,T:T,B:B,n:n,X:X,Y:Y,lanes:LANE,LH:LH};

    var s='';
    // y grid + labels
    var ticks=algoTicks(lo,hi,5);
    ticks.forEach(function(v){
      var y=Y(v);
      s+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+R+'" y2="'+y.toFixed(1)+'" stroke="var(--grid)" stroke-width="1"/>';
      s+='<text x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" style="font-size:11px;fill:var(--faint)">'+algoSym(d.currency)+comma(v>=100?String(Math.round(v)):v.toFixed(1))+'</text>';
    });
    // price line
    var path='';
    days.forEach(function(x,i){ path+=(i?" L ":"M ")+X(i).toFixed(1)+" "+Y(x.close).toFixed(1); });
    s+='<path d="'+path+'" fill="none" stroke="var(--s-total)" stroke-width="1.6" stroke-linejoin="round"/>';

    // x labels
    var every=Math.max(1,Math.round(n/6));
    for(var i=0;i<n;i+=every){
      var p=days[i].date.split("-"), mn=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+p[1]-1];
      s+='<text x="'+X(i).toFixed(1)+'" y="262" text-anchor="middle" style="font-size:11px;fill:var(--faint)">'+mn+" "+p[0]+'</text>';
    }

    // the two lanes
    LANE.forEach(function(ln){
      s+='<text class="algo-lanelab" data-lane="'+(ln.key==="e"?"early":"confirmed")+'" x="'+(L-8)+'" y="'+(ln.y+LH/2+4)+'" text-anchor="end">'+ln.label+'</text>';
      s+='<rect x="'+L+'" y="'+ln.y+'" width="'+(R-L)+'" height="'+LH+'" fill="var(--grid)" opacity="0.5" rx="2"/>';
      days.forEach(function(x,i){
        // One hue per direction, four intensities by tier: bright for very strong,
        // light for strong, pale for a signal, faintest for a watch. Grey now means
        // only one thing — the rules said nothing at all that day.
        //
        // The steps are deliberately separated rather than following confidence
        // continuously — the spec's smooth opacity ramp put 67% and 83% within a
        // hair of each other, and the whole point of the tiers is that you can tell
        // them apart at a glance.
        //
        // The palest step is not cosmetic: a buy only the Early lane sees comes from
        // one window, one window is worth at most 2 of the maximum 6, and 33% can
        // never climb higher. Without it the two lanes were provably identical on
        // every one of 7,560 displayable days.
        var lane=x[ln.key], col, op;
        var dirCol=lane.d==="Buy"?"var(--pos)":lane.d==="Sell"?"var(--neg)":"var(--warn)";
        if(lane.d==="None"){ col="var(--faint)"; op=0.13; }
        else if(lane.t==="VeryStrong"){ col=dirCol; op=lane.c>=100?1:0.85; }
        else if(lane.t==="Strong"){ col=dirCol; op=lane.c>=67?0.58:0.47; }
        else if(lane.t==="Signal"){ col=dirCol; op=0.32; }
        else { col=dirCol; op=0.22; }   // Watch: the faintest a reading gets
        s+='<rect x="'+(L+(R-L)*i/n).toFixed(2)+'" y="'+ln.y+'" width="'+bw.toFixed(2)+'" height="'+LH+'" fill="'+col+'" opacity="'+op.toFixed(2)+'"/>';
      });
    });

    // ---- events timeline ----
    // Not one bar per day like the lanes above: these are moments, so they are
    // marks. Anything dated outside the displayed window is simply not drawn.
    s+='<text class="algo-lanelab" data-lane="events" x="'+(L-8)+'" y="'+(EVY+5)+'" text-anchor="end">Events</text>';
    s+='<line x1="'+L+'" y1="'+EVY+'" x2="'+R+'" y2="'+EVY+'" stroke="var(--hair)" stroke-width="1"/>';
    var evByIndex={};
    (d.events||[]).forEach(function(ev){
      var i=algoIndexForDate(days,ev.date);
      if(i<0) return;
      (evByIndex[i]||(evByIndex[i]=[])).push(ev);
    });
    var evIdx=Object.keys(evByIndex);
    if(!evIdx.length){
      s+='<text x="'+((L+R)/2)+'" y="'+(EVY+5)+'" text-anchor="middle" style="font-size:11px;fill:var(--faint)">no emails sent and no settings changed in this period</text>';
    } else {
      evIdx.forEach(function(k){
        var i=parseInt(k,10), list=evByIndex[i], x=X(i);
        // Only an email that actually left gets the loud treatment. One the mailer
        // refused is still a moment worth marking — it explains a gap — but it must
        // not look like something that arrived.
        var hasEmail=list.some(function(e){ return e.type==="email" && e.sent!==false; });
        var col=hasEmail?"var(--pos)":"var(--muted)";
        s+='<line x1="'+x.toFixed(1)+'" y1="'+(EVY-7)+'" x2="'+x.toFixed(1)+'" y2="'+(EVY+7)+'" stroke="'+col+'" stroke-width="1.5" opacity="0.85"/>';
        if(hasEmail){
          // an email is the rarer, louder thing: give it a head so it reads at a glance
          s+='<circle cx="'+x.toFixed(1)+'" cy="'+(EVY-9)+'" r="3" fill="var(--pos)"/>';
        }
      });
    }

    // crosshair + hover target, added last so it sits on top
    s+='<line id="algo-cross" x1="0" y1="'+T+'" x2="0" y2="'+(EVY+10)+'" stroke="var(--muted)" stroke-width="1" opacity="0"/>';
    s+='<circle id="algo-dot" r="3.5" fill="var(--s-total)" opacity="0"/>';
    s+='<rect id="algo-hit" x="'+L+'" y="'+T+'" width="'+(R-L)+'" height="'+(EVY+12-T)+'" fill="transparent" style="cursor:crosshair"/>';

    var svg=document.getElementById("algo-chart");
    svg.innerHTML=s;
    bindAlgoHover(d);
  }

  /**
   * Which displayed trading day an event belongs to. An event dated on a weekend
   * or a market holiday attaches to the next trading day rather than vanishing;
   * one before the window starts is dropped.
   */
  function algoIndexForDate(days,date){
    if(!days.length||date<days[0].date) return -1;
    for(var i=0;i<days.length;i++) if(days[i].date>=date) return i;
    return days.length-1;
  }

  function algoTicks(lo,hi,count){
    var span=hi-lo; if(span<=0) return [lo];
    var raw=span/count, mag=Math.pow(10,Math.floor(Math.log(raw)/Math.LN10)), norm=raw/mag, step;
    if(norm<1.5) step=mag; else if(norm<3) step=2*mag; else if(norm<7) step=5*mag; else step=10*mag;
    var out=[], v=Math.ceil(lo/step)*step;
    for(;v<=hi;v+=step) out.push(Math.round(v*1e6)/1e6);
    return out;
  }

  function bindAlgoHover(d){
    var svg=document.getElementById("algo-chart"), tip=document.getElementById("algo-tip");
    var hit=document.getElementById("algo-hit"), cross=document.getElementById("algo-cross"), dot=document.getElementById("algo-dot");
    var g=ALGO_GEO;

    function toViewBox(ev){
      var r=svg.getBoundingClientRect();
      return {x:(ev.clientX-r.left)*(960/r.width), rect:r};
    }
    function laneLine(x,key,name){
      var l=x[key];
      if(l.d==="None") return name+": <span style=\"color:var(--faint)\">nothing</span>";
      var col=l.d==="Buy"?"var(--pos)":l.d==="Sell"?"var(--neg)":"#d69a2e";
      return name+': <b style="color:'+col+'">'+l.d+'</b> · '+esc(algoTierWord(l.t))+' '+l.c+'%';
    }
    hit.addEventListener("mousemove",function(ev){
      var v=toViewBox(ev);
      var i=Math.round((v.x-g.L)/(g.R-g.L)*g.n-0.5);
      if(i<0) i=0; if(i>g.n-1) i=g.n-1;
      var x=d.days[i], px=g.X(i);
      cross.setAttribute("x1",px); cross.setAttribute("x2",px); cross.setAttribute("opacity","0.45");
      dot.setAttribute("cx",px); dot.setAttribute("cy",g.Y(x.close)); dot.setAttribute("opacity","1");
      var evHere=(d.events||[]).filter(function(ev){ return algoIndexForDate(d.days,ev.date)===i; });
      tip.innerHTML='<div style="font-weight:600;margin-bottom:5px">'+algoDate(x.date)+'</div>'+
        '<div style="font-variant-numeric:tabular-nums;margin-bottom:6px">'+algoMoney(x.close,d.currency)+'</div>'+
        '<div style="font-size:11.5px;line-height:1.7">'+
        laneLine(x,"e","Early")+'<br>'+laneLine(x,"f","Confirmed")+
        '<div style="margin-top:6px;border-top:1px solid var(--hair);padding-top:5px;color:var(--muted)">'+
        d.meta.windows.map(function(w){
          return w.key+' '+esc(algoRegimeWord(x.rg[w.key]))+' <span style="color:var(--faint)">('+algoPct(x.pr[w.key])+')</span>';
        }).join("<br>")+'</div>'+
        (evHere.length?'<div style="margin-top:6px;border-top:1px solid var(--hair);padding-top:5px">'+
          evHere.map(function(ev){
            var arrived=ev.type==="email"&&ev.sent!==false;
            return '<span style="color:'+(arrived?"var(--pos)":"var(--muted)")+'">&#9679;</span> '+esc(ev.label)+': '+esc(ev.detail);
          }).join("<br>")+'</div>':'')+'</div>';
      var left=px/960*v.rect.width;
      tip.style.left=Math.max(90,Math.min(v.rect.width-90,left))+"px";
      tip.style.top="8px";
      tip.style.opacity="1";
    });
    hit.addEventListener("mouseleave",function(){
      tip.style.opacity="0"; cross.setAttribute("opacity","0"); dot.setAttribute("opacity","0");
    });

    // Lane-name tooltips are driven from here rather than a title attribute: the
    // native one is slow to appear and is suppressed entirely inside an embedded
    // preview, which is exactly where these most need to be readable.
    Array.prototype.forEach.call(svg.querySelectorAll(".algo-lanelab"),function(el){
      el.addEventListener("mouseenter",function(){
        var r=svg.getBoundingClientRect(), box=el.getBoundingClientRect();
        tip.innerHTML='<div style="font-size:11.5px;line-height:1.6">'+ALGO_LANE_TEXT[el.dataset.lane]+'</div>';
        tip.style.left=Math.min(r.width-120,140)+"px";
        tip.style.top=(box.top-r.top-8)+"px";
        tip.style.opacity="1";
      });
      el.addEventListener("mouseleave",function(){ tip.style.opacity="0"; });
    });
  }

  function renderAlgoRuns(d){
    function col(title,runs,cls,empty){
      var body=runs.length?runs.slice(0,6).map(function(r){
        return '<div class="algo-run '+cls+'"><div class="r-d">'+algoDate(r.start)+' &rarr; '+algoDate(r.end)+'</div>'+
          '<div class="r-p">'+r.days+' day'+(r.days===1?"":"s")+' · '+algoMoney(r.startClose,d.currency)+' &rarr; '+algoMoney(r.endClose,d.currency)+
          ' · peak '+Math.round(r.peakConfidence)+'%</div></div>';
      }).join(""):'<div class="algo-runempty">'+empty+'</div>';
      var more=runs.length>6?'<div class="r-p" style="color:var(--faint);font-size:11px">and '+(runs.length-6)+' earlier</div>':'';
      return '<div class="algo-runcol"><h4>'+title+'</h4>'+body+more+'</div>';
    }
    document.getElementById("algo-runs").innerHTML=
      col("Sell-zone runs",d.runs.sell,"sell","No sell run reached Signal strength in this period.")+
      col("Buy-zone runs — early",d.runs.buyEarly,"buy","No early buy run in this period.")+
      col("Buy-zone runs — confirmed",d.runs.buyConfirmed,"buy","No buy run had two windows agreeing.");
  }

  function renderAlgoTable(d){
    var rows=d.days.slice().reverse();
    function cell(l){ return '<td class="algo-cell-'+algoDirClass(l.d)+'">'+(l.d==="None"?"—":esc(l.d)+" "+l.c+"%")+'</td>'; }
    document.getElementById("algo-table").innerHTML=
      '<thead><tr><th>Date</th><th>Close</th><th>6M</th><th>1Y</th><th>2Y</th><th>Early</th><th>Confirmed</th></tr></thead><tbody>'+
      rows.map(function(x){
        return '<tr><td>'+x.date+'</td><td>'+algoMoney(x.close,d.currency)+'</td>'+
          ['6M','1Y','2Y'].map(function(k){
            return '<td>'+esc(algoRegimeWord(x.rg[k]))+' <span style="color:var(--faint)">'+algoPct(x.pr[k])+'</span></td>';
          }).join("")+cell(x.e)+cell(x.f)+'</tr>';
      }).join("")+'</tbody>';
  }

  function renderAlgoFoot(d){
    var g=d.gate;
    var txt="What this catches: stretches where this stock&rsquo;s price is unusual <b>by its own recent standards</b>. What it cannot catch: anything about the company. "+
      "A price low enough to flag Buy is equally consistent with a bargain and with something genuinely broken, and nothing in these numbers separates the two. "+
      "Sell is deliberately harder to trigger than Buy, so expect the sell lane to be quiet through a long climb and the early buy lane to speak first in a fall.";
    if(g&&g.applicable){
      txt+=" Your own position <b>is</b> wired in: a flag only reads &ldquo;position agrees&rdquo; once you are "+
        d.meta.gates.strongHighGainPct+"–"+d.meta.gates.highGainPct+"% ahead for a sell, or "+
        Math.abs(d.meta.gates.lowLossPct)+"–"+Math.abs(d.meta.gates.strongLowLossPct)+"% behind for a buy. The lanes above stay purely technical either way.";
    } else {
      txt+=" Position-aware gating is inactive for this holding because there is no share count and average cost to gate against.";
    }
    document.getElementById("algo-foot").innerHTML=txt;
  }

  (function(){
    var btn=document.getElementById("algo-table-btn");
    if(!btn) return;
    btn.addEventListener("click",function(){
      var holder=document.getElementById("algo-table-holder"), show=holder.hidden;
      holder.hidden=!show;
      btn.setAttribute("aria-expanded",show?"true":"false");
      btn.textContent=show?"Hide the full data table":"Show the full data table";
    });
  })();

  /* ================= tabs ================= */
  // Portfolio-over-time and Portfolio-in-detail were one subject behind two clicks; they are
  // one view now, chart first. Transactions sits last because it is the tab you visit least.
  var TABS=[["tab-total","view-total"],["tab-dca","view-dca"],["tab-algo","view-algo"],["tab-alerts","view-alerts"],["tab-add","view-add"]];
  TABS.forEach(function(pair){
    document.getElementById(pair[0]).addEventListener("click",function(){
      TABS.forEach(function(p){
        var on=p[0]===pair[0];
        document.getElementById(p[0]).setAttribute("aria-selected",on?"true":"false");
        document.getElementById(p[1]).hidden=!on;
      });
      // the strip scrolls sideways when it does not fit; bring the tapped tab fully
      // into view rather than leaving it clipped at the edge you tapped
      var btn=document.getElementById(pair[0]);
      if(btn.scrollIntoView) btn.scrollIntoView({block:"nearest",inline:"nearest",behavior:"smooth"});
      if(pair[0]==="tab-dca") loadAndRenderDCA();
      if(pair[0]==="tab-algo") loadAndRenderAlgo();
    });
  });

  /* ================= ADD DATA ================= */
  var toastEl=document.getElementById("toast"), toastT;
  function toast(msg, type){
    toastEl.textContent=msg;
    toastEl.classList.remove("error", "success");
    if(type==="error") toastEl.classList.add("error");
    if(type==="success") toastEl.classList.add("success");
    toastEl.classList.add("on");
    clearTimeout(toastT);
    toastT=setTimeout(function(){ toastEl.classList.remove("on"); },type==="error"?4000:2600);
  }
  function showError(msg){ console.error(msg); toast("❌ "+msg,"error"); }
  function showSuccess(msg){ toast("✓ "+msg,"success"); }
  function todayISO(){ var d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

  /* ================= transactions ================= */
  var transactions=[], txType="buy";

  function loadTransactions(){
    apiFetch("./api/transactions")
      .then(function(r){
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(function(d){
        transactions=d.transactions||[];
        // Extract exchange rates by ticker
        transactions.forEach(function(tx){
          if(tx.currency==="USD" && tx.exchangeRate){
            TICKER_EXCHANGE_RATE[tx.ticker.toUpperCase()]=tx.exchangeRate;
          }
        });
        renderTransactionList();
      })
      .catch(function(e){
        console.error("Failed to load transactions:",e.message);
        showError('Failed to load transactions');
      });
  }

  function renderTransactionList(){
    var list=document.getElementById("tx-list"), cnt=document.getElementById("tx-count");
    cnt.textContent=transactions.length?"("+transactions.length+")":"";
    if(!transactions.length){ list.innerHTML='<div class="usempty">None yet. Register one above.</div>'; return; }
    list.innerHTML="";
    transactions.slice().sort(function(a,b){return b.ts-a.ts;}).forEach(function(tx){
      var isUSD=tx.currency==="USD";
      var origAmount=isUSD&&tx.exchangeRate?tx.amount/tx.exchangeRate:tx.amount;
      var amtStr=nfEur2.format(origAmount)+(isUSD?"$":"€");
      var totalStr=isUSD?" × "+tx.exchangeRate+" = €"+nfEur2.format(tx.amount):"";
      var typeLabel=tx.type==="sell"?"Sell":"Buy";
      var row=document.createElement("div"); row.className="usrow";
      row.innerHTML='<span class="ud">'+stampLabel(tx.ts)+'</span><span class="um">'+esc(tx.ticker)+'</span><span class="um">'+tx.quantity+' shares</span><span class="um">'+amtStr+totalStr+'</span><span class="ub">'+typeLabel+'</span>'+
        '<button class="ux" title="Delete" aria-label="Delete transaction">×</button>';
      row.querySelector(".ux").addEventListener("click",function(){
        apiFetch("./api/transactions/"+tx.id,{method:"DELETE"}).then(function(){
          transactions=transactions.filter(function(t){return t.id!==tx.id;});
          renderTransactionList();
          refreshPortfolio();
          toast("Transaction removed");
        });
      });
      list.appendChild(row);
    });
  }

  document.getElementById("tx-currency").addEventListener("change",function(e){
    document.getElementById("tx-rate-row").hidden=(e.target.value==="EUR");
  });


  var typeSwitch=document.getElementById("tx-type-switch");
  if(typeSwitch) Array.prototype.forEach.call(typeSwitch.querySelectorAll(".type-switch-opt"),function(opt){
    opt.addEventListener("click",function(){
      txType=opt.dataset.type;
      typeSwitch.dataset.active=txType;
    });
  });

  document.getElementById("tx-save").addEventListener("click",function(){
    var nt=document.getElementById("tx-note"); nt.className="frm-note";
    var dv=document.getElementById("tx-date").value, tv=document.getElementById("tx-time").value||"12:00";
    if(!dv){ nt.textContent="Pick a date."; return; }
    var ts=new Date(dv+"T"+tv).getTime();
    if(isNaN(ts)){ nt.textContent="Invalid date/time."; return; }

    var ticker=(document.getElementById("tx-ticker").value||"").toUpperCase().trim();
    var qty=parseFloat(document.getElementById("tx-qty").value);
    var amount=parseFloat(document.getElementById("tx-amount").value);
    var currency=document.getElementById("tx-currency").value;

    if(!ticker){ nt.textContent="Enter a ticker."; return; }
    if(!(qty>0)){ nt.textContent="Quantity must be > 0."; return; }
    if(!(amount>0)){ nt.textContent="Amount must be > 0."; return; }

    var amountEUR=amount;
    if(currency==="USD"){
      var rate=parseFloat(document.getElementById("tx-rate").value);
      if(!(rate>0)){ nt.textContent="Enter exchange rate."; return; }
      amountEUR=Math.round(amount*rate*100)/100;
    }

    // The chart used to be updated here, from a snapshot built in the browser and kept
    // in localStorage. It was wrong in three ways: it valued the new position at what
    // you paid rather than at market, it was never removed when the transaction was
    // deleted, and it outlived the page — so one stale copy went on overriding the tail
    // of the chart on that browser forever. The server recomputes the whole series from
    // the transactions themselves; refreshPortfolio() below just asks it to.
    var txRecord={ts:ts, ticker:ticker, quantity:qty, amount:amount, currency:currency, amountEUR:amountEUR, type:txType};
    apiFetch("./api/transactions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(txRecord)}).then(function(r){
      return r.json();
    }).then(function(d){
      transactions.push(d.transaction);
      renderTransactionList();
      refreshPortfolio();
      nt.textContent=""; nt.className="frm-note ok";
      nt.textContent=txType.charAt(0).toUpperCase()+txType.slice(1)+" "+qty+" "+ticker+" for €"+nfEur2.format(amountEUR);
      document.getElementById("tx-ticker").value="";
      document.getElementById("tx-qty").value="";
      document.getElementById("tx-amount").value="";
      document.getElementById("tx-rate").value="";
      toast(txType.charAt(0).toUpperCase()+txType.slice(1)+" "+qty+" "+ticker);
      // A ticker priced for the first time has no past until it is fetched.
      if(!LATEST_PRICES[ticker]){
        toast("Loading "+histYears+"y of history for "+ticker+"\u2026");
        apiFetch("./api/backfill",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ticker:ticker,years:histYears})})
          .then(function(r){ return r.json(); })
          .then(function(d){
            if(d && d.success){
              toast(ticker+": "+d.added+" days of history loaded");
              document.getElementById("tx-hist-row").hidden=true;
              if(typeof loadAndRenderPrices==="function") loadAndRenderPrices();
              refreshPortfolio();   // the new history changes what the past is worth
            } else { showError((d&&d.error)||"Could not load history for "+ticker); }
          })
          .catch(function(e2){ showError("History load failed: "+e2.message); });
      }
    }).catch(function(e){
      nt.className="frm-note err";
      nt.textContent="Server error: "+e.message;
    });
  });

  // Depth of history to pull for a ticker the app has never priced before.
  var histYears=2;
  function refreshHistPrompt(){
    var row=document.getElementById("tx-hist-row");
    if(!row) return;
    var t=(document.getElementById("tx-ticker").value||"").toUpperCase().trim();
    var known=!!LATEST_PRICES[t];
    row.hidden=!(t.length>=1 && !known);
    if(!row.hidden) document.getElementById("tx-hist-ticker").textContent=t;
  }

  /* ================= alerts ================= */
  var alerts=[];
  var AVG_COST={}; // ticker -> {quantity, avgCostEUR, currentPriceEUR, currentPriceUSD, dipPct}

  /* ---- one form, three rules ----
   *
   * Dip, target and trailing were three cards of the same shape: pick a holding,
   * pick a percentage, read back the price it would fire at. Everything that
   * differed between them was a value — which presets, what the percentage is
   * measured against, what the preview says — so those values live here and one
   * form reads from the table. A fourth percentage rule is an entry here, not a
   * fourth card.
   *
   * Each type keeps its own preset and its own custom box, so flipping between
   * them to compare does not silently rewrite the one you had set up.
   */
  var RULE_TYPES={
    dip:{
      ruleType:"dip_from_avg_cost", noun:"Dip alert", title:"Dip", valueMode:"pct",
      hint:"Get an email when a stock drops a set % below your own average purchase price for it \u2014 a signal to consider reinforcing the position.",
      pctLabel:"Alert when down",
      presets:["5","7","10","12.5","15"], preset:"5", custom:"",
      customAttrs:{placeholder:"e.g. 20", step:"0.5", min:"0.5"},
      customLabel:"Custom dip percentage",
      valid:function(v){ return v>0; },
      spark:function(info,pct){ return {costBased:true, trigger:info.avgCostEUR*(1-pct/100), avgCost:info.avgCostEUR}; },
      pickNote:"Pick a dip % (or enter a valid custom value).",
      fired:function(t,p){ return "Dip alert created for "+t+" at \u2212"+p+"%."; }
    },
    gain:{
      ruleType:"gain_from_avg_cost", noun:"Target alert", title:"Target", valueMode:"pct",
      hint:"The other half of the plan: get an email when a stock is a set % <b>above</b> your own average purchase price \u2014 a signal to consider taking some profit. The target follows your cost basis, so it stays meaningful as you keep buying.",
      pctLabel:"Alert when up",
      presets:["25","50","75","100","150"], preset:"25", custom:"",
      customAttrs:{placeholder:"e.g. 200", step:"5", min:"1"},
      customLabel:"Custom target percentage",
      valid:function(v){ return v>0; },
      spark:function(info,pct){ return {costBased:true, trigger:info.avgCostEUR*(1+pct/100), avgCost:info.avgCostEUR}; },
      pickNote:"Pick or enter a target %.",
      fired:function(t,p){ return "Target alert created for "+t+" at +"+p+"%."; }
    },
    high:{
      ruleType:"drop_from_high", noun:"Trailing alert", title:"Trailing", valueMode:"pct",
      hint:"Get an email when a stock has fallen a set % below its own <b>highest price of the past year</b>. Unlike dip and target it is measured against the market, not your cost \u2014 so it still says something once a holding has run up well past what you paid, and it does not go stale as the stock moves.",
      pctLabel:"Alert when off its high by",
      presets:["10","15","20","25","30"], preset:"20", custom:"",
      customAttrs:{placeholder:"e.g. 35", step:"0.5", min:"0.5"},
      customLabel:"Custom percentage off the high",
      // a stock cannot fall 100% below its own high and still have a price
      valid:function(v){ return v>0 && v<100; },
      spark:function(info,pct){ return info.recentHigh==null?null:{costBased:false, trigger:info.recentHigh*(1-pct/100), avgCost:null}; },
      pickNote:"Pick or enter a % between 0.5 and 100.",
      fired:function(t,p){ return "Trailing alert created for "+t+" at \u2212"+p+"% off its high."; }
    },
    price:{
      // the rule type depends on the direction, so it is decided at submit
      ruleType:null, noun:"Price alert", title:"Price level", valueMode:"price",
      hint:"Get an email when a stock reaches a price you name. The one rule that ignores both what you paid and where the stock has been \u2014 it just watches the number, in the currency its own market quotes.",
      direction:"above", price:"",
      valid:function(v){ return v>0; },
      spark:function(info,price){ return {costBased:false, trigger:price, avgCost:null}; },
      pickNote:"Enter a price above 0.",
      fired:function(t,p,cur){ return "Price alert created for "+t+" \u2014 "+(RULE_TYPES.price.direction==="above"?"above ":"below ")+fmtNative(p,cur)+"."; }
    }
  };
  var ruleKind="dip";
  function ruleSpec(){ return RULE_TYPES[ruleKind]; }

  function loadAvgCostAndRuleForm(){
    return apiFetch('./api/avg-cost')
      .then(function(r){ return r.json(); })
      .then(function(data){
        AVG_COST={};
        (data.tickers||[]).forEach(function(t){ AVG_COST[t.ticker]=t; });
        var tickers=Object.keys(AVG_COST);
        var opts=tickers.length
          ? tickers.map(function(t){
              var nm=tickerLabel(t);
              return '<option value="'+t+'">'+esc(nm)+' ('+t+')</option>';
            }).join("")
          : '<option value="">No holdings yet</option>';
        var sel=document.getElementById("rule-ticker");
        if(sel) sel.innerHTML=opts;
        renderRulePreview();
        renderAlertTickerPicker();
        if(AM_TICKER) amLoadSeries(AM_TICKER).then(renderAlertMap);
      })
      .catch(function(err){ console.error('Failed to load avg cost:',err); });
  }

  function currentRuleThreshold(){
    var spec=ruleSpec();
    if(spec.valueMode==="price"){
      var pv=parseFloat(spec.price);
      return spec.valid(pv)?pv:null;
    }
    if(spec.preset==="custom"){
      var v=parseFloat(spec.custom);
      return spec.valid(v)?v:null;
    }
    return parseFloat(spec.preset);
  }

  /* The three previews quote different things — two measure against your cost and
     talk in your currency, the trailing one measures against the market's own high
     and stays in the market's currency throughout, because mixing the two would
     invite comparing a euro trigger against a dollar high. */
  function previewDip(box, ticker, pct, info){
    if(!pct){ box.textContent="Pick a dip % (or enter a custom one) to see the trigger price."; return; }
    var isUSD=TICKER_CURRENCY[ticker]==="USD";
    var rate=TICKER_EXCHANGE_RATE[ticker]||CURRENT_EUR_TO_USD||1.087;
    var avgCost=isUSD?info.avgCostEUR*rate:info.avgCostEUR;
    var triggerPrice=avgCost*(1-pct/100);
    var current=isUSD?info.currentPriceUSD:info.currentPriceEUR;
    var fmt=isUSD?usd:eur;
    var already=current!=null && current<=triggerPrice;
    // "\u22125%" to match the other two types, which sit one button away now — the dip
    // preview used to render this as "-5,0%" and the inconsistency was invisible while
    // the three were separate cards
    box.innerHTML="Your average cost: <b>"+fmt(avgCost)+"</b> \u00b7 Triggers at \u2212"+pct+"% \u2192 <b>"+fmt(triggerPrice)+"</b>"+
      (current!=null?"<br>Current price: "+fmt(current)+" ("+dp(current/avgCost-1)+" vs. your cost)"+(already?" \u2014 <span class='pos'>would trigger right away</span>":""):"");
  }

  function previewGain(box, ticker, pct, info){
    if(!pct){ box.textContent="Pick a target % (or enter a custom one) to see the price it fires at."; return; }
    var isUSD=TICKER_CURRENCY[ticker]==="USD";
    var rate=TICKER_EXCHANGE_RATE[ticker]||CURRENT_EUR_TO_USD||1.087;
    var avgCost=isUSD?info.avgCostEUR*rate:info.avgCostEUR;
    var triggerPrice=avgCost*(1+pct/100);
    var current=isUSD?info.currentPriceUSD:info.currentPriceEUR;
    var fmt=isUSD?usd:eur;
    var already=current!=null && current>=triggerPrice;
    box.innerHTML="Your average cost: <b>"+fmt(avgCost)+"</b> \u00b7 Triggers at +"+pct+"% \u2192 <b>"+fmt(triggerPrice)+"</b>"+
      (current!=null?"<br>Current price: "+fmt(current)+" ("+dp(current/avgCost-1)+" vs. your cost)"+(already?" \u2014 <span class='pos'>would trigger right away</span>":""):"");
  }

  function previewHigh(box, ticker, pct, info){
    if(info.recentHigh==null){
      box.textContent="No price history stored for "+ticker+" yet, so there is no high to measure against. Register a transaction with a history depth, or wait for the daily fetch to build one up.";
      return;
    }
    if(!pct){ box.textContent="Pick a % (or enter a custom one) to see the price it fires at."; return; }
    var cur=info.currency||"USD";
    var high=info.recentHigh, trigger=high*(1-pct/100);
    var current=info.currentPriceNative;
    var when=info.recentHighDate?new Date(info.recentHighDate).toLocaleDateString(undefined,{month:"short",year:"numeric"}):null;
    var already=current!=null && current<=trigger;
    box.innerHTML="High of the past year: <b>"+fmtNative(high,cur)+"</b>"+(when?" ("+when+")":"")
      +" \u00b7 Triggers at &minus;"+pct+"% \u2192 <b>"+fmtNative(trigger,cur)+"</b>"
      +(current!=null?"<br>Current price: "+fmtNative(current,cur)+" ("+dp(current/high-1)+" off that high)"
        +(already?" \u2014 <span class='neg'>would trigger right away</span>":""):"");
  }
  function previewPrice(box, ticker, price, info){
    var cur=info.currency||"USD";
    var current=info.currentPriceNative;
    if(!price){
      box.textContent="Enter a price to see how far "+ticker+" is from it.";
      return;
    }
    var above=RULE_TYPES.price.direction==="above";
    var already=current!=null && (above?current>=price:current<=price);
    // "+64%" beside a "below" rule that is already firing reads as a contradiction; say
    // which side of today's price the level sits on instead of signing the number
    var away=current!=null?comma(Math.abs(price/current-1)*100<0.05?"0.0":(Math.abs(price/current-1)*100).toFixed(1)):null;
    box.innerHTML="Fires when "+esc(ticker)+" trades <b>"+(above?"above ":"below ")+fmtNative(price,cur)+"</b>"
      +(current!=null?"<br>Current price: "+fmtNative(current,cur)+" \u2014 the level sits "+away+"% "
        +(price>=current?"above":"below")+" it"
        +(already?" \u2014 <span class='"+(above?"pos":"neg")+"'>would trigger right away</span>":""):"");
  }
  var RULE_PREVIEWS={dip:previewDip, gain:previewGain, high:previewHigh, price:previewPrice};

  function renderRulePreview(){
    var box=document.getElementById("rule-preview");
    if(!box) return;
    var ticker=document.getElementById("rule-ticker").value;
    var info=AVG_COST[ticker];
    if(!info){ box.textContent="Add a transaction for this stock first \u2014 an alert needs a holding to measure against."; return; }
    RULE_PREVIEWS[ruleKind](box, ticker, currentRuleThreshold(), info);
    renderRuleSpark(ticker, info);
  }

  /* The same picture the alert list draws, before the alert exists: a level the stock
     reaches four times a year and one it has never come near read identically as two
     numbers and not at all alike as a chart. */
  var SPARK_ASKED={};
  function renderRuleSpark(ticker, info){
    var slot=document.getElementById("rule-spark");
    if(!slot) return;
    var spec=ruleSpec(), pct=currentRuleThreshold();
    var s=(pct&&spec.spark)?spec.spark(info,pct):null;
    if(!s||s.trigger==null){ slot.innerHTML=""; return; }
    if(!ALERT_HISTORY[ticker]){
      slot.innerHTML="";
      // asked once per ticker: a holding with no stored history would otherwise send a
      // request on every keystroke in the custom box and never get an answer
      if(!SPARK_ASKED[ticker]){
        SPARK_ASKED[ticker]=1;
        loadAlertHistory([ticker]).then(function(){
          // the stock may have been changed again while that was in flight
          if(document.getElementById("rule-ticker").value===ticker) renderRulePreview();
        });
      }
      return;
    }
    var svg=alertSpark(ticker, s.costBased, s.trigger, s.avgCost);
    slot.innerHTML=svg
      ? svg+'<span class="cap">Six months of price \u00b7 <span style="color:var(--neg)">\u2014</span> the level that fires'
            +(s.avgCost!=null?' \u00b7 <span style="color:var(--faint)">- -</span> your average cost':'')+'</span>'
      : "";
  }

  /* Everything on the form that the type decides: the explanation, what the
     percentage is called, which presets are offered, and how the custom box is
     labelled and stepped. Called on load and on every type change. */
  function renderRuleForm(){
    var spec=ruleSpec(), presets=document.getElementById("rule-presets");
    if(!presets) return;
    document.getElementById("rule-title").textContent=spec.title;
    document.getElementById("rule-hint").innerHTML=spec.hint;
    // three of the four types are a percentage off a reference; the fourth is a price
    // with a direction, so the two control blocks swap rather than sharing a shape
    document.getElementById("rule-pct-wrap").hidden=(spec.valueMode!=="pct");
    document.getElementById("rule-price-wrap").hidden=(spec.valueMode!=="price");
    if(spec.valueMode==="price"){ renderRulePriceField(); renderRulePreview(); return; }
    document.getElementById("rule-value-label").textContent=spec.pctLabel;
    presets.innerHTML=spec.presets.map(function(p){
      return '<button type="button" data-pct="'+p+'" aria-pressed="'+(spec.preset===p?"true":"false")+'">'+p+'%</button>';
    }).join("")+'<button type="button" data-pct="custom" aria-pressed="'+(spec.preset==="custom"?"true":"false")+'">Custom</button>';
    Array.prototype.forEach.call(presets.querySelectorAll("button"),function(b){
      b.addEventListener("click",function(){
        spec.preset=b.dataset.pct;
        Array.prototype.forEach.call(presets.querySelectorAll("button"),function(x){ x.setAttribute("aria-pressed", x===b?"true":"false"); });
        syncRuleCustom();
        if(spec.preset==="custom") document.getElementById("rule-custom").focus();
        renderRulePreview();
      });
    });
    syncRuleCustom();
    renderRulePreview();
  }

  /* The price is entered in the currency the holding's own market quotes, which is
     knowable now that the stock comes from a list rather than a free-text box — the
     old form could only label this "Threshold" and hope. */
  function renderRulePriceField(){
    var spec=RULE_TYPES.price, box=document.getElementById("rule-price");
    var info=AVG_COST[document.getElementById("rule-ticker").value];
    var cur=info&&info.currency;
    document.getElementById("rule-price-label").textContent=cur?("Price ("+cur+")"):"Price";
    box.value=spec.price;
    Array.prototype.forEach.call(document.querySelectorAll("#rule-dirs button"),function(b){
      b.setAttribute("aria-pressed", b.dataset.dir===spec.direction?"true":"false");
    });
  }

  function syncRuleCustom(){
    var spec=ruleSpec(), box=document.getElementById("rule-custom");
    box.hidden=(spec.preset!=="custom");
    box.value=spec.custom;
    box.placeholder=spec.customAttrs.placeholder;
    box.step=spec.customAttrs.step;
    box.min=spec.customAttrs.min;
    box.setAttribute("aria-label",spec.customLabel);
  }

  function createRuleAlert(){
    var spec=ruleSpec(), nt=document.getElementById("rule-note");
    nt.className="frm-note"; nt.textContent="";
    var ticker=document.getElementById("rule-ticker").value;
    var pct=currentRuleThreshold();
    if(!ticker){ nt.className="frm-note err"; nt.textContent="No stock to alert on \u2014 add a transaction first."; return; }
    if(!pct){ nt.className="frm-note err"; nt.textContent=spec.pickNote; return; }
    var info=AVG_COST[ticker]||{};
    var ruleType=spec.ruleType||("price_"+spec.direction);
    apiFetch('./api/alerts',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ticker:ticker,ruleType:ruleType,threshold:pct})})
      .then(r=>r.json().then(d=>({ok:r.ok,d:d})))
      .then(({ok,d})=>{
        if(!ok||d.error){ nt.className="frm-note err"; nt.textContent=(d&&d.error)||"Could not create the alert."; return; }
        nt.className="frm-note ok"; nt.textContent=spec.fired(ticker,pct,info.currency||"USD");
        toast(spec.noun+" created for "+ticker);
        loadAlerts();
      })
      .catch(e=>{ nt.className="frm-note err"; nt.textContent="Server error: "+e.message; });
  }

  /* Alert sparkline: what the rule is watching for, drawn.
     Six months of price, a dashed line at your average cost, a solid line at the
     level that fires, and the gap between today's price and that level shaded —
     so "a 15% dip on TSLA" is something you can see rather than infer from two
     numbers. The scale always includes the trigger, otherwise a distant target
     would simply not appear on the chart. */
  var ALERT_HISTORY={}; // ticker -> [{d,eur,native,currency}]

  function loadAlertHistory(tickers){
    if(!tickers.length) return Promise.resolve();
    return apiFetch('./api/price-history?days=180&tickers='+encodeURIComponent(tickers.join(',')))
      .then(function(r){ return r.ok?r.json():{series:{}}; })
      .then(function(d){ Object.assign(ALERT_HISTORY,d.series||{}); })
      .catch(function(){ /* the list still works without pictures */ });
  }

  function alertSpark(ticker, costBased, trigger, avgCost){
    var raw=ALERT_HISTORY[ticker]||[];
    if(raw.length<2||trigger==null) return '';
    // cost-based rules are reasoned about in euros; price levels in the market's own
    var vals=raw.map(function(p){ return costBased?p.eur:(p.native!=null?p.native:p.eur); })
                .filter(function(v){ return v!=null; });
    if(vals.length<2) return '';

    var W=170,H=46,PAD=3;
    var lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
    lo=Math.min(lo,trigger); hi=Math.max(hi,trigger);          // always show the target
    if(avgCost!=null){ lo=Math.min(lo,avgCost); hi=Math.max(hi,avgCost); }
    if(hi-lo<1e-9) hi=lo+1;
    var y=function(v){ return PAD+(1-(v-lo)/(hi-lo))*(H-2*PAD); };
    var x=function(i){ return (i/(vals.length-1))*W; };

    var d=vals.map(function(v,i){ return (i?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1); }).join(' ');
    var last=vals[vals.length-1], yNow=y(last), yTrig=y(trigger);

    var gap='<rect x="0" y="'+Math.min(yNow,yTrig).toFixed(1)+'" width="'+W+'" height="'
      +Math.abs(yTrig-yNow).toFixed(1)+'" fill="var(--accent-soft)"></rect>';
    var avgLine=avgCost!=null
      ? '<line x1="0" y1="'+y(avgCost).toFixed(1)+'" x2="'+W+'" y2="'+y(avgCost).toFixed(1)
        +'" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3"></line>' : '';
    var trigLine='<line x1="0" y1="'+yTrig.toFixed(1)+'" x2="'+W+'" y2="'+yTrig.toFixed(1)
      +'" stroke="var(--neg)" stroke-width="1.5"></line>';

    return '<svg class="al-spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" '
      +'aria-label="Six months of price against the level this alert fires at">'
      +gap+avgLine+trigLine
      +'<path d="'+d+'" fill="none" stroke="var(--s-total)" stroke-width="1.6" stroke-linejoin="round"></path>'
      +'<circle cx="'+(W-1)+'" cy="'+yNow.toFixed(1)+'" r="2.6" fill="var(--s-total)"></circle>'
      +'</svg>';
  }

  function loadAlerts(){
    apiFetch('./api/alerts')
      .then(r=>{
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(data=>{
        alerts=data.alerts||[];
        // sparklines need the price series; render regardless if it fails
        var tickers=[...new Set(alerts.map(a=>a.ticker))];
        return loadAlertHistory(tickers).then(function(){
          renderAlerts();
          renderAlertTickerPicker();
          if(AM_TICKER) amLoadSeries(AM_TICKER).then(renderAlertMap); else renderAlertMap();
        });
      })
      .catch(err=>{
        console.error('Failed to load alerts:',err.message);
        showError('Failed to load alerts');
      });
  }

  /* ================= alert map =================
     The list can say a rule is 2.6% from firing; it cannot say whether that is a level
     the stock actually visits. Drawn against the price, a rule that fired four times
     this year and one that has never come close stop looking the same.

     Everything is drawn in the market's own currency, matching the price. The two
     cost-based rules are euro thresholds, so they are converted at each date's own
     implied rate (native/eur from that day's row) rather than at today's — which is
     why those lines can drift slightly even when your average cost has not moved.
     Triggering is always tested in the rule's own currency, never the drawn one. */
  var AM_TICKER=null, AM_PERIOD="1y", AM_SERIES={}, AM_PENDING={};
  var AM_DAYS={"3m":90,"6m":180,"1y":365,"2y":730,"all":3650};
  var AM_HIGH_DAYS=365;   // must match HIGH_WINDOW_DAYS in db-migrations.js

  function amTs(d){ return new Date(d+"T00:00:00Z").getTime(); }
  function amNat(p){ return p.native!=null?p.native:p.eur; }
  function amRatio(p){ return (p.native!=null && p.eur)?p.native/p.eur:1; }

  function amLoadSeries(ticker){
    if(AM_SERIES[ticker]) return Promise.resolve(AM_SERIES[ticker]);
    if(AM_PENDING[ticker]) return AM_PENDING[ticker];
    AM_PENDING[ticker]=apiFetch('./api/price-history?days=3650&tickers='+encodeURIComponent(ticker))
      .then(function(r){ return r.ok?r.json():{series:{}}; })
      .then(function(d){ AM_SERIES[ticker]=((d.series||{})[ticker])||[]; delete AM_PENDING[ticker]; return AM_SERIES[ticker]; })
      .catch(function(){ AM_SERIES[ticker]=[]; delete AM_PENDING[ticker]; return []; });
    return AM_PENDING[ticker];
  }

  // Highest close in the trailing window ending at each date — the moving reference a
  // trailing rule measures against, which is why its level is a line and not a level.
  function amRollingHigh(S,days){
    var out=[], dq=[], ms=days*864e5;
    for(var i=0;i<S.length;i++){
      var t=amTs(S[i].d), v=amNat(S[i]);
      while(dq.length && amTs(S[dq[0]].d)<t-ms) dq.shift();
      while(dq.length && amNat(S[dq[dq.length-1]])<=v) dq.pop();
      dq.push(i);
      out.push(amNat(S[dq[0]]));
    }
    return out;
  }

  // One descriptor per rule: where its line sits at each date, and whether it is firing
  // there. Kept as functions so a moving level and a flat one draw through the same code.
  // Colour follows the rule *type*, matching the tags in the list below — a dip is green
  // there and green here. Index-based colours shifted every time an alert was added.
  var AM_TYPE_COLOR={dip_from_avg_cost:3,gain_from_avg_cost:2,drop_from_high:5,price_above:1,price_below:1};
  var AM_TYPE_ORDER={dip_from_avg_cost:0,gain_from_avg_cost:1,drop_from_high:2,price_below:3,price_above:4};

  function amRules(ticker,S){
    var mine=alerts.filter(function(a){ return a.ticker===ticker; }).sort(function(x,y){
      return (AM_TYPE_ORDER[x.ruleType]-AM_TYPE_ORDER[y.ruleType]) || (x.threshold-y.threshold);
    });
    var roll=null, used={};
    return mine.map(function(a,k){
      // a second rule of the same type falls through to a free slot rather than
      // drawing two indistinguishable lines
      var want=AM_TYPE_COLOR[a.ruleType]||4, n=want;
      while(used[n]) n=n%6+1;
      used[n]=true;
      var col="var(--am-c"+n+")";
      var r={a:a,color:col,dynamic:false,enabled:!!a.enabled};
      if(a.ruleType==="dip_from_avg_cost"||a.ruleType==="gain_from_avg_cost"){
        var isDip=a.ruleType==="dip_from_avg_cost", lvlEUR=a.triggerPriceEUR;
        r.levelAt=function(i){ return lvlEUR==null?null:lvlEUR*amRatio(S[i]); };
        r.firedAt=function(i){ var v=S[i].eur;
          return v!=null && lvlEUR!=null && (isDip?v<=lvlEUR:v>=lvlEUR); };
        r.label=(isDip?"Dip −":"Target +")+a.threshold+"% on cost";
        r.tag=isDip?"dip":"gain";
      } else if(a.ruleType==="drop_from_high"){
        if(!roll) roll=amRollingHigh(S,AM_HIGH_DAYS);
        r.dynamic=true;
        r.levelAt=function(i){ return roll[i]*(1-a.threshold/100); };
        r.firedAt=function(i){ var v=amNat(S[i]); return v!=null && v<=roll[i]*(1-a.threshold/100); };
        r.label="Trailing −"+a.threshold+"% off high";
        r.tag="high";
        r.roll=roll;
      } else {
        var above=a.ruleType==="price_above", lvl=a.threshold;
        r.levelAt=function(){ return lvl; };
        r.firedAt=function(i){ var v=amNat(S[i]); return v!=null && (above?v>lvl:v<lvl); };
        r.label="Price "+(above?"above":"below")+" "+fmtNative(lvl,a.currency||a.marketCurrency);
        r.tag="lvl";
      }
      return r;
    });
  }

  function amXTicks(t0,t1){
    var span=t1-t0;
    var step=span>730*864e5?6:(span>365*864e5?3:(span>150*864e5?2:1));
    // anchor the sequence on January so a year boundary is always one of the ticks —
    // stepping from the window's own first month hid "2026" whenever it fell between two
    var d0=new Date(t0), y=d0.getUTCFullYear(), m=Math.floor(d0.getUTCMonth()/step)*step;
    var d=new Date(Date.UTC(y,m,1));
    if(d.getTime()<t0) d=new Date(Date.UTC(y,m+step,1));
    var out=[];
    while(d.getTime()<=t1){
      var isYear=d.getUTCMonth()===0;
      out.push({t:d.getTime(),isYear:isYear,
        lab:isYear?String(d.getUTCFullYear()):["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()]});
      d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+step,1));
    }
    return out;
  }

  function renderAlertTickerPicker(){
    var box=document.getElementById("am-tickers"); if(!box) return;
    var counts={};
    alerts.forEach(function(a){ counts[a.ticker]=(counts[a.ticker]||0)+1; });
    var list=Object.keys(AVG_COST||{});
    Object.keys(counts).forEach(function(t){ if(list.indexOf(t)<0) list.push(t); });
    list.sort(function(x,y){ return (counts[y]||0)-(counts[x]||0) || x.localeCompare(y); });
    if(!list.length){ box.innerHTML='<span style="font-size:12.5px;color:var(--faint)">Register a transaction first — the map draws a holding you own.</span>'; return; }
    if(!AM_TICKER || list.indexOf(AM_TICKER)<0) AM_TICKER=list[0];
    box.innerHTML=list.map(function(t){
      var n=counts[t]||0;
      return '<button type="button" class="chip" data-t="'+esc(t)+'" aria-pressed="'+(t===AM_TICKER)+'">'+esc(t)
        +(n?'<span class="am-n">'+n+'</span>':'')+'</button>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll("button"),function(b){
      b.addEventListener("click",function(){ amSelect(b.dataset.t); });
    });
  }

  function amSelect(ticker){
    AM_TICKER=ticker;
    renderAlertTickerPicker();
    amLoadSeries(ticker).then(renderAlertMap);
  }

  function renderAlertMap(){
    var svg=document.getElementById("am-chart"); if(!svg) return;
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    var rowsBox=document.getElementById("am-rows"), sub=document.getElementById("am-sub"),
        note=document.getElementById("am-note"), lg=document.getElementById("am-legend"),
        tip=document.getElementById("am-tip");
    rowsBox.innerHTML=""; lg.innerHTML=""; note.textContent="";
    if(!AM_TICKER){
      sub.textContent="";
      drawEmptyChart(svg,"Pick a holding above to see its price with every rule you have on it drawn across the same chart.",false);
      return;
    }
    clearEmptyChart(svg);

    var name=tickerLabel(AM_TICKER);
    sub.textContent="· "+name;
    var S=AM_SERIES[AM_TICKER];
    if(!S){ amLoadSeries(AM_TICKER).then(renderAlertMap); return; }
    if(S.length<2){
      note.textContent="";
      drawEmptyChart(svg,"No stored price history for "+AM_TICKER+" yet. Register a transaction for it and choose a history depth, or wait for the daily fetch to build one up.",false);
      return;
    }

    // window
    var i0=0;
    if(AM_PERIOD!=="all"){
      var cut=Date.now()-AM_DAYS[AM_PERIOD]*864e5;
      while(i0<S.length-2 && amTs(S[i0].d)<cut) i0++;
    }
    var cur=S[S.length-1].currency||"USD";
    var rules=amRules(AM_TICKER,S);
    var info=(AVG_COST||{})[AM_TICKER];
    var avgAt=function(i){ return (info&&info.avgCostEUR!=null)?info.avgCostEUR*amRatio(S[i]):null; };

    // vertical domain: the price band, plus any level close enough to be worth showing.
    // A +200% target on a stock that has not moved would otherwise flatten the price
    // into a horizontal line, which is exactly the chart nobody can read.
    var pv=[]; for(var i=i0;i<S.length;i++){ var v=amNat(S[i]); if(v!=null) pv.push(v); }
    var pMin=Math.min.apply(null,pv), pMax=Math.max.apply(null,pv), span=(pMax-pMin)||pMax*0.1;
    // a level may stretch the scale by at most a third of the price band in each
    // direction — past that the price flattens into a ribbon and the chart stops
    // answering the question it exists for
    var loLim=pMin-span*0.35, hiLim=pMax+span*0.35;
    var dLo=pMin, dHi=pMax;
    function consider(v){ if(v==null) return false;
      if(v<loLim||v>hiLim) return false;
      dLo=Math.min(dLo,v); dHi=Math.max(dHi,v); return true; }
    rules.forEach(function(r){
      var lo=null,hi=null;
      for(var i=i0;i<S.length;i++){ var v=r.levelAt(i); if(v==null) continue;
        lo=(lo==null?v:Math.min(lo,v)); hi=(hi==null?v:Math.max(hi,v)); }
      r.lvlLo=lo; r.lvlHi=hi;
      r.onChart=(consider(lo)|consider(hi))>0 || (lo!=null&&lo<=hiLim&&hi>=loLim);
      if(r.onChart){ if(lo!=null) dLo=Math.min(dLo,Math.max(lo,loLim)); if(hi!=null) dHi=Math.max(dHi,Math.min(hi,hiLim)); }
      else if(lo!=null) r.offDir=lo>hiLim?"above":"below";
    });
    var av=avgAt(S.length-1); var avgOn=consider(av);

    var W=960,H=430,l=70,r=132,tp=20,bt=36,pW=W-l-r,pH=H-tp-bt;
    var tks=niceTicksGeneric(dLo-(dHi-dLo)*0.04,dHi+(dHi-dLo)*0.04,5);
    var yhi=Math.max(tks[tks.length-1],dHi), ylo=Math.min(tks[0],dLo);
    var t0=amTs(S[i0].d), t1=amTs(S[S.length-1].d);
    function X(i){ return l+(amTs(S[i].d)-t0)/((t1-t0)||1)*pW; }
    function Y(v){ return tp+(1-(v-ylo)/((yhi-ylo)||1))*pH; }
    function Yc(v){ return Math.max(tp,Math.min(tp+pH,Y(v))); }

    tks.forEach(function(t){ var y=Y(t); if(y<tp-1||y>tp+pH+1) return;
      svg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5});
      lb.textContent=fmtNative(t,cur); svg.appendChild(lb);
    });
    svg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:tp+pH,y2:tp+pH}));
    amXTicks(t0,t1).forEach(function(m){
      var x=l+(m.t-t0)/((t1-t0)||1)*pW; if(x<l||x>W-r) return;
      svg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:tp,y2:tp+pH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:tp+pH+21});
      if(m.isYear){ lb.setAttribute("font-weight","600"); lb.setAttribute("fill","var(--ink)"); }
      lb.textContent=m.lab; svg.appendChild(lb);
    });

    // your average cost, first so the price and the rules sit on top of it
    if(avgOn){
      var ad=""; for(var i=i0;i<S.length;i++){ var v=avgAt(i); if(v==null) continue;
        ad+=(ad?" L ":"M ")+X(i).toFixed(1)+" "+Y(v).toFixed(1); }
      if(ad){
        svg.appendChild(el("path",{class:"serieline",d:ad,stroke:"var(--muted)","stroke-width":1.4,"stroke-dasharray":"5 4"}));
        var alb=el("text",{class:"endlbl",x:W-r+8,y:Yc(av)+3.5,fill:"var(--muted)"});
        alb.textContent="Avg cost "+fmtNative(av,cur); svg.appendChild(alb);
      }
    }

    // each rule's level, then its firing markers on the price
    var ends=[];
    rules.forEach(function(rr){
      if(!rr.onChart) return;
      var d="";
      for(var i=i0;i<S.length;i++){ var v=rr.levelAt(i); if(v==null) continue;
        d+=(d?" L ":"M ")+X(i).toFixed(1)+" "+Yc(v).toFixed(1); }
      if(!d) return;
      var path=el("path",{class:"serieline",d:d,stroke:rr.color,"stroke-width":rr.dynamic?1.6:1.5,
        "stroke-dasharray":rr.dynamic?"none":"7 4",opacity:rr.enabled?1:.4});
      svg.appendChild(path);
      var lv=rr.levelAt(S.length-1);
      if(lv!=null) ends.push({y:Yc(lv),col:rr.color,txt:fmtNative(lv,cur),dim:!rr.enabled});
    });

    // price on top
    var pd="";
    for(var i=i0;i<S.length;i++){ var v=amNat(S[i]); if(v==null) continue;
      pd+=(pd?" L ":"M ")+X(i).toFixed(1)+" "+Y(v).toFixed(1); }
    svg.appendChild(el("path",{class:"serieline",d:pd,stroke:"var(--ink)","stroke-width":2}));
    ends.push({y:Y(amNat(S[S.length-1])),col:"var(--ink)",txt:fmtNative(amNat(S[S.length-1]),cur),lead:true});

    // where each rule would have fired: the day it crossed, not every day it stayed past
    rules.forEach(function(rr){
      rr.hits=[];
      for(var i=i0;i<S.length;i++){
        var now=rr.firedAt(i), prev=i>0?rr.firedAt(i-1):false;
        if(now&&!prev) rr.hits.push(i);
      }
      rr.hits.forEach(function(i){
        var v=amNat(S[i]); if(v==null) return;
        var g=el("g",{});
        g.appendChild(el("circle",{cx:X(i).toFixed(1),cy:Y(v).toFixed(1),r:5.5,fill:rr.color,opacity:.18}));
        g.appendChild(el("circle",{cx:X(i).toFixed(1),cy:Y(v).toFixed(1),r:3,fill:rr.color,
          stroke:"var(--surface)","stroke-width":1.2,opacity:rr.enabled?1:.45}));
        svg.appendChild(g);
      });
    });

    // stack end labels so they never overlap
    ends.sort(function(a,b){ return a.y-b.y; });
    for(var e=1;e<ends.length;e++) if(ends[e].y-ends[e-1].y<12) ends[e].y=ends[e-1].y+12;
    ends.forEach(function(en){
      var lb=el("text",{class:"endlbl",x:W-r+8,y:en.y+3.5,fill:en.col,opacity:en.dim?.5:1});
      lb.textContent=en.txt; svg.appendChild(lb);
    });

    /* hover: date, price, and how far each rule is from firing on that day */
    var cross=el("line",{class:"crosshair",x1:0,x2:0,y1:tp,y2:tp+pH,opacity:0});
    var fdot=el("circle",{r:4,class:"focus-dot",fill:"var(--ink)",opacity:0});
    svg.appendChild(cross); svg.appendChild(fdot);
    var hit=el("rect",{x:l,y:tp,width:pW,height:pH,fill:"transparent",style:"cursor:crosshair"});
    var box=svg.parentNode;
    hit.addEventListener("pointermove",function(ev){
      var rect=svg.getBoundingClientRect();
      var vx=(ev.clientX-rect.left)/rect.width*W;
      var frac=Math.max(0,Math.min(1,(vx-l)/pW));
      var target=t0+frac*(t1-t0), best=i0, bd=Infinity;
      for(var i=i0;i<S.length;i++){ var dd=Math.abs(amTs(S[i].d)-target); if(dd<bd){ bd=dd; best=i; } }
      var px=X(best), pv2=amNat(S[best]);
      cross.setAttribute("x1",px); cross.setAttribute("x2",px); cross.setAttribute("opacity",1);
      fdot.setAttribute("cx",px); fdot.setAttribute("cy",Y(pv2)); fdot.setAttribute("opacity",1);
      var html='<div class="th">'+S[best].d+'</div>'
        +'<div class="row"><span class="lab"><i style="background:var(--ink)"></i>Price</span><span class="v">'+fmtNative(pv2,cur)+'</span></div>';
      rules.forEach(function(rr){
        var lv=rr.levelAt(best); if(lv==null) return;
        var gap=(pv2-lv)/lv*100, fired=rr.firedAt(best);
        html+='<div class="row"><span class="lab"><i style="background:'+rr.color+'"></i>'+esc(rr.label)+'</span>'
          +'<span class="v">'+(fired?"firing":(gap>=0?"+":"−")+comma(Math.abs(gap).toFixed(1))+"%")+'</span></div>';
      });
      tip.innerHTML=html; tip.classList.add("on");
      var relX=px/W*box.clientWidth, tw=tip.offsetWidth;
      tip.style.left=Math.max(tw/2+4,Math.min(box.clientWidth-tw/2-4,relX))+"px";
      tip.style.top=Math.max(4,Y(pv2)/H*box.clientHeight-tip.offsetHeight-14)+"px";
    });
    hit.addEventListener("pointerleave",function(){
      tip.classList.remove("on"); cross.setAttribute("opacity",0); fdot.setAttribute("opacity",0);
    });
    svg.appendChild(hit);

    /* legend + one row per rule: what it fires at, how far away, how often it fired */
    lg.innerHTML='<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)"><i style="width:11px;height:11px;border-radius:3px;background:var(--ink)"></i>Price</span>'
      +(avgOn?'<span style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)"><i style="width:11px;height:2px;background:var(--muted)"></i>Your average cost</span>':'');

    if(!rules.length){
      rowsBox.innerHTML='<p class="hint" style="margin:12px 0 0">No alerts on '+esc(AM_TICKER)+' yet &mdash; the forms above create one, and it will appear here as a line.</p>';
    } else {
      var days=Math.round((t1-t0)/864e5);
      rowsBox.innerHTML='<div class="am-rows">'+rules.map(function(rr){
        var lvNow=rr.levelAt(S.length-1), pNow=amNat(S[S.length-1]);
        var gap=(lvNow!=null&&pNow)?(pNow-lvNow)/pNow*100:null;
        var firing=rr.firedAt(S.length-1);
        var last=rr.hits.length?S[rr.hits[rr.hits.length-1]].d:null;
        return '<div class="am-row'+(rr.enabled?"":" off")+'">'
          +'<span class="am-sw" style="background:'+rr.color+'"></span>'
          +'<span class="am-lab">'+esc(rr.label)+(rr.enabled?"":' <span class="al-off" style="display:inline">paused</span>')+'</span>'
          +'<span class="am-v">'+(lvNow!=null?fmtNative(lvNow,cur):"—")+(rr.dynamic?' <span class="am-mv">moves</span>':'')+'</span>'
          +'<span class="am-v'+(firing?" fire":"")+'">'+(firing?"firing now":(gap==null?"—":comma(Math.abs(gap).toFixed(1))+"% "+(gap>0?"to fall":"to rise")))+'</span>'
          +'<span class="am-hits">'+(rr.hits.length?('<b>'+rr.hits.length+'×</b> in '+(days>400?Math.round(days/365)+"y":days+"d")+(last?' · last '+last:'')):'never in this window')+'</span>'
          +(rr.onChart?'':'<span class="am-off2">'+(rr.offDir==="below"?"below":"above")+' the chart</span>')
        +'</div>';
      }).join("")+'</div>';
    }

    var offs=rules.filter(function(rr){ return !rr.onChart; }).length;
    note.innerHTML="Markers are the day a rule <b>crossed</b> into firing, not every day it stayed there, and they use the levels as they stand today applied to past prices &mdash; your average cost has changed over time, this does not model that. A trailing rule recomputes its own "
      +AM_HIGH_DAYS+"-day high at each date, so its line moves. Triggering is tested in each rule's own currency; the drawing is in "+cur+"."
      +(offs?" "+offs+" rule"+(offs>1?"s sit":" sits")+" too far from the current price to fit on the chart without flattening it — the row below still gives the level and the distance.":"");
  }


  function renderAlerts(){
    var list=document.getElementById("al-list");
    var count=document.getElementById("al-count");
    if(!list) return;

    count.textContent="("+alerts.length+")";

    if(alerts.length===0){
      list.innerHTML='<p style="color:var(--faint);font-size:13px">No alerts yet. Create one to get started.</p>';
      return;
    }

    // Each alert is reduced to the numbers that decide whether to care: what it
    // fires at, where the price is now, and how far it still has to move. That last
    // one — headroom — is the whole question ("is this close?") and previously had
    // to be worked out in your head from two figures buried in 12px grey text.
    var rows=alerts.map(a=>{
      var isDip=a.ruleType==="dip_from_avg_cost";
      var isGain=a.ruleType==="gain_from_avg_cost";
      var isHigh=a.ruleType==="drop_from_high";
      var costBased=isDip||isGain;
      var cur=costBased?"EUR":(a.currency||a.marketCurrency||"USD");
      var trigger=isHigh?a.triggerPriceNative:(costBased?a.triggerPriceEUR:a.threshold);
      var now=costBased?a.currentPriceEUR:a.currentPriceNative;

      // percentage the price must still move for this rule to fire
      var movePct=null, dir="";
      if(trigger!=null && now!=null && now>0){
        // a gain target and a price_above both need the price to climb
        if(a.ruleType==="price_above"||isGain){ movePct=(trigger-now)/now*100; dir="rise"; }
        else { movePct=(now-trigger)/now*100; dir="fall"; }
      }
      return {a:a,isDip:isDip,isGain:isGain,isHigh:isHigh,cur:cur,trigger:trigger,now:now,movePct:movePct,dir:dir};
    });
    // closest to firing first — the ones worth looking at are at the top
    // already-firing rules first (negative gap), then closest to firing
    var rank=function(v){ return v.movePct==null?1e9:(v.movePct<=0?-1e9+v.movePct:v.movePct); };
    rows.sort((x,y)=>rank(x)-rank(y));

    var head='<div class="al-row al-head">'
      +'<div>Ticker</div><div>Rule</div><div class="al-num">Fires at</div>'
      +'<div class="al-num">Now</div><div>Headroom</div><div>Watching</div><div></div></div>';

    list.innerHTML=head+rows.map(r=>{
      var a=r.a;
      var last=a.lastTriggeredAt?new Date(a.lastTriggeredAt).toLocaleDateString():"never";
      var rule=r.isDip
        ? '<span class="al-tag dip">Dip</span>'+a.threshold+'% below avg cost'
        : r.isGain
        ? '<span class="al-tag gain">Target</span>'+a.threshold+'% above avg cost'
        : r.isHigh
        ? '<span class="al-tag high">Trailing</span>'+a.threshold+'% off 52w high'
        : '<span class="al-tag lvl">Level</span>Price '+(a.ruleType==="price_above"?"above":"below");

      var head2="—", bar="";
      if(r.movePct!=null){
        var pct=Math.abs(r.movePct);
        if(r.movePct<=0){
          // the price is already past the level: taking the absolute value made
          // this read "7.2% to fall" for a rule that had in fact already fired
          head2='<span class="al-move fired">Live</span>'
            +'<span class="al-dir">past by '+pct.toFixed(1)+'%</span>';
          bar='<div class="al-bar"><i style="width:100%"></i></div>';
        } else {
          // near = within 10% of firing; the bar fills as the gap closes
          var near=pct<10, fill=Math.max(3,Math.min(100,(1-pct/40)*100));
          head2='<span class="al-move'+(near?" near":"")+'">'+pct.toFixed(1)+'%</span>'
            +'<span class="al-dir">to '+r.dir+'</span>';
          bar='<div class="al-bar"><i style="width:'+fill.toFixed(0)+'%"></i></div>';
        }
      }

      return '<div class="al-row'+(a.enabled?"":" off")+'">'
        +'<div class="al-tk">'+yahooQuoteLink(a.ticker)+(a.enabled?"":'<span class="al-off">paused</span>')+'</div>'
        +'<div class="al-rule">'+rule+'</div>'
        +'<div class="al-num al-trig" data-l="fires at">'+(r.trigger!=null?fmtNative(r.trigger,r.cur):"—")+'</div>'
        +'<div class="al-num" data-l="now">'+(r.now!=null?fmtNative(r.now,r.cur):"—")+'</div>'
        +'<div class="al-head2">'+head2+bar+'</div>'
        +'<div class="al-sparkcell">'+alertSpark(a.ticker,r.isDip||r.isGain,r.trigger,
             r.isHigh?a.recentHigh:a.avgCostEUR)+'</div>'
        +'<div class="al-act">'
          +'<button class="mini" data-action="toggle" data-id="'+a.id+'" title="Last triggered: '+last+'">'+(a.enabled?"On":"Off")+'</button>'
          +'<button class="mini" data-action="delete" data-id="'+a.id+'">Delete</button>'
        +'</div>'
      +'</div>';
    }).join('');

    list.querySelectorAll('[data-action="toggle"]').forEach(btn=>{
      btn.addEventListener("click",e=>{
        var id=parseInt(e.target.dataset.id);
        var a=alerts.find(x=>x.id===id);
        if(a) updateAlert(id,!a.enabled,null);
      });
    });

    list.querySelectorAll('[data-action="delete"]').forEach(btn=>{
      btn.addEventListener("click",e=>{
        var id=parseInt(e.target.dataset.id);
        if(confirm("Delete this alert?")) deleteAlert(id);
      });
    });
  }

  function updateAlert(id,enabled,threshold){
    var body={};
    if(enabled!==null) body.enabled=enabled;
    if(threshold!==null) body.threshold=threshold;

    apiFetch('./api/alerts/'+id,{
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    }).then(r=>r.json()).then(data=>{
      if(data.error){ console.error(data.error); return; }
      var idx=alerts.findIndex(x=>x.id===id);
      if(idx>=0) alerts[idx]=data.alert;
      renderAlerts();
    }).catch(err=>console.error('Failed to update alert:',err));
  }

  function deleteAlert(id){
    apiFetch('./api/alerts/'+id,{
      method:'DELETE'
    }).then(r=>r.json()).then(data=>{
      if(data.error){ console.error(data.error); return; }
      alerts=alerts.filter(x=>x.id!==id);
      renderAlerts();
    }).catch(err=>console.error('Failed to delete alert:',err));
  }

  if(document.getElementById("tx-hist-presets")){
    document.getElementById("tx-ticker").addEventListener("input",refreshHistPrompt);
    Array.prototype.forEach.call(document.querySelectorAll("#tx-hist-presets button"),function(b){
      b.addEventListener("click",function(){
        histYears=parseFloat(b.dataset.years);
        Array.prototype.forEach.call(document.querySelectorAll("#tx-hist-presets button"),function(x){
          x.setAttribute("aria-pressed", x===b?"true":"false"); });
      });
    });
  }

  if(document.getElementById("am-periods")){
    Array.prototype.forEach.call(document.querySelectorAll("#am-periods button"),function(b){
      b.addEventListener("click",function(){
        AM_PERIOD=b.dataset.p;
        Array.prototype.forEach.call(document.querySelectorAll("#am-periods button"),function(x){
          x.setAttribute("aria-pressed", x===b?"true":"false"); });
        renderAlertMap();
      });
    });
  }

  if(document.getElementById("rule-create")){
    document.getElementById("rule-create").addEventListener("click",createRuleAlert);
    document.getElementById("rule-ticker").addEventListener("change",function(){
      if(ruleSpec().valueMode==="price") renderRulePriceField();
      renderRulePreview();
    });
    document.getElementById("rule-price").addEventListener("input",function(){
      RULE_TYPES.price.price=this.value;
      renderRulePreview();
    });
    Array.prototype.forEach.call(document.querySelectorAll("#rule-dirs button"),function(b){
      b.addEventListener("click",function(){
        RULE_TYPES.price.direction=b.dataset.dir;
        Array.prototype.forEach.call(document.querySelectorAll("#rule-dirs button"),function(x){ x.setAttribute("aria-pressed", x===b?"true":"false"); });
        renderRulePreview();
      });
    });
    document.getElementById("rule-custom").addEventListener("input",function(){
      ruleSpec().custom=this.value;   // remembered per type, not shared
      renderRulePreview();
    });
    Array.prototype.forEach.call(document.querySelectorAll("#rule-types button"),function(b){
      b.addEventListener("click",function(){
        ruleKind=b.dataset.type;
        Array.prototype.forEach.call(document.querySelectorAll("#rule-types button"),function(x){ x.setAttribute("aria-pressed", x===b?"true":"false"); });
        renderRuleForm();
      });
    });
    renderRuleForm();
  }

  document.getElementById("tab-alerts").addEventListener("click",function(){
    loadAlerts();
    loadAvgCostAndRuleForm();
  });

  /* ================= fetch and display prices ================= */
  function loadAndRenderPrices(){
    apiFetch('./api/prices')
      .then(r=>{
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(data=>{
        if(!data.prices || data.prices.length===0){
          console.warn('No prices available from API');
          return;
        }

        LATEST_PRICES={};
        data.prices.forEach(p=>{
          var t=p.ticker.toUpperCase();
          LATEST_PRICES[t]={
            priceEUR:p.priceEUR,
            priceUSD:p.priceUSD,
            priceNative:p.priceNative,
            currency:p.currency,
            date:p.date,
            updatedAt:p.updatedAt
          };
        });

        // Calculate current exchange rate from latest prices
        if(data.prices.length>0){
          var p=data.prices[0];
          if(p.priceEUR && p.priceUSD){
            CURRENT_EUR_TO_USD=p.priceUSD/p.priceEUR;
          }
        }

        renderHeadline();
        renderPricesTable();
      })
      .catch(err=>{
        console.error('Failed to load prices:',err.message);
        showError('Could not load price data (markets may be closed)');
      });
  }

  function renderPricesTable(){
    var table=document.getElementById("prices-table");
    if(!table) return;

    var priceArray=Object.keys(LATEST_PRICES).map(ticker=>{
      var p=LATEST_PRICES[ticker];
      return {ticker, priceEUR:p.priceEUR, priceUSD:p.priceUSD, date:p.date, updatedAt:p.updatedAt};
    }).sort((a,b)=>a.ticker.localeCompare(b.ticker));

    // Check for missing tickers
    var missingTickers=[];
    if(UNI){
      UNI.forEach(function(u){
        var bnIdx=BNAMES.indexOf(u.name);
        if(bnIdx>=0){
          var ticker=BKEY[bnIdx].toUpperCase();
          if(!LATEST_PRICES[ticker]) missingTickers.push(ticker);
        }
      });
    }

    var lastUpdate=priceArray.length>0?new Date(priceArray[0].updatedAt):null;
    var lastUpdateStr=lastUpdate?lastUpdate.toLocaleDateString()+" "+lastUpdate.toLocaleTimeString():"—";

    // Quoted price in the market's own currency; the euro column is the converted
    // figure the portfolio total is built from, so both are worth showing here.
    var html='<thead><tr><th>Ticker</th><th>Price</th><th>In EUR</th><th>Date</th></tr></thead><tbody>'+
      priceArray.map(p=>{
        var cur=p.currency||"USD";
        var native=p.priceNative!=null?p.priceNative:p.priceUSD;
        return '<tr><td><b>'+esc(p.ticker)+'</b></td>'+
          '<td>'+fmtNative(native,cur)+'</td>'+
          '<td>'+(cur==="EUR"?'<span style="color:var(--faint)">—</span>':'€ '+nfEur2.format(p.priceEUR))+'</td>'+
          '<td>'+new Date(p.date).toLocaleDateString()+'</td></tr>';
      }).join('');

    if(missingTickers.length>0){
      html+='<tr style="background:var(--surface-2)"><td colspan="4" style="text-align:center;color:var(--faint);font-size:12px;padding:12px">⚠️ No price data for: '+missingTickers.join(', ')+'</td></tr>';
    }

    html+='</tbody>';
    table.innerHTML=html;
  }

  /* ================= DCA (dollar-cost-averaging opportunity finder) ================= */
  var DCA_HISTORY={}; // ticker -> [{date, ts, priceEUR, priceUSD}]
  var DCA_TICKERS=[]; // tickers with enough history to analyze
  var dcaSelected=null;
  var DCA_MIN_POINTS=20;
  var DCA_WINDOW_DAYS=365;
  var DCA_DIP_THRESHOLD=-0.05;

  function loadAndRenderDCA(){
    // The list used to come from the chart's universe, whose keys are the legacy short
    // names this app started with — "asml", "vw", "spy" — not Yahoo symbols. A European
    // listing keeps its exchange suffix (ASML.AS, VOW3.DE) and reuses the existing name
    // slot, so its real symbol never reached that list: two held stocks asked for price
    // history under a symbol that has none and were quietly dropped from the selector.
    // /api/avg-cost is keyed by the real symbol and is, by definition, what you hold.
    var ready=Object.keys(AVG_COST).length?Promise.resolve():loadAvgCostAndRuleForm();
    return ready.then(function(){ return renderDCATickers(); });
  }

  function renderDCATickers(){
    var tickers=Object.keys(AVG_COST);
    if(!tickers.length){
      document.getElementById("dca-tickers").innerHTML='<span class="lbl" style="padding:6px 10px">Register a transaction first &mdash; this tab analyses what you hold</span>';
      var thin=document.getElementById("dca-thin"); if(thin) thin.innerHTML="";
      drawEmptyChart(document.getElementById("dca-price"),"Each holding\u2019s price against its own trailing average \u2014 the case for adding when it sits below, for trimming when it runs above.",true);
      drawEmptyChart(document.getElementById("dca-bb"),"Bollinger bands: how far the price has strayed from its own recent range.",false);
      drawEmptyChart(document.getElementById("dca-dev"),"The same distance as a percentage, above and below zero.",false);
      var tbl=document.getElementById("dca-table"); if(tbl) tbl.innerHTML="";
      return Promise.resolve();
    }
    ["dca-price","dca-bb","dca-dev"].forEach(function(id){ clearEmptyChart(document.getElementById(id)); });
    var toFetch=tickers.filter(function(t){ return !DCA_HISTORY[t]; });
    return Promise.all(toFetch.map(function(t){
      return apiFetch('./api/price-history/'+t)
        .then(function(r){ return r.ok?r.json():{history:[]}; })
        .then(function(data){
          DCA_HISTORY[t]=(data.history||[]).map(function(h){ return {date:h.date, ts:new Date(h.date).getTime(), priceEUR:h.priceEUR, priceUSD:h.priceUSD}; }).sort(function(a,b){ return a.ts-b.ts; });
        })
        .catch(function(){ DCA_HISTORY[t]=[]; });
    })).then(function(){
      DCA_TICKERS=tickers.filter(function(t){ return DCA_HISTORY[t] && DCA_HISTORY[t].length>=DCA_MIN_POINTS; });
      var thin=tickers.filter(function(t){ return DCA_TICKERS.indexOf(t)===-1; });
      if(!DCA_TICKERS.length){
        document.getElementById("dca-tickers").innerHTML='<span class="lbl" style="padding:6px 10px">No holding has enough price history yet &mdash; register a transaction with a history depth, or wait for the daily fetch</span>';
        return;
      }
      if(!dcaSelected || DCA_TICKERS.indexOf(dcaSelected)===-1) dcaSelected=DCA_TICKERS[0];
      document.getElementById("dca-tickers").innerHTML=DCA_TICKERS.map(function(t){
        var nm=tickerLabel(t);
        return '<button data-ticker="'+t+'" aria-pressed="'+(t===dcaSelected?"true":"false")+'">'+esc(nm)+'</button>';
      }).join("");
      // say so rather than silently shortening the list, which is how the old bug hid
      var note=document.getElementById("dca-thin");
      if(note) note.innerHTML=thin.length
        ? "Not shown: "+thin.map(esc).join(", ")+" &mdash; fewer than "+DCA_MIN_POINTS+" days of stored prices. Backfill more history from the transaction form."
        : "";
      Array.prototype.forEach.call(document.querySelectorAll("#dca-tickers button"),function(b){
        b.addEventListener("click",function(){
          dcaSelected=b.dataset.ticker;
          Array.prototype.forEach.call(document.querySelectorAll("#dca-tickers button"),function(x){ x.setAttribute("aria-pressed", x===b?"true":"false"); });
          renderDCA();
        });
      });
      renderDCA();
    });
  }

  function niceTicksGeneric(lo,hi,count){
    var span=hi-lo; if(span<=0) return [lo];
    var rawStep=span/count;
    var mag=Math.pow(10,Math.floor(Math.log(rawStep)/Math.LN10));
    var norm=rawStep/mag, step;
    if(norm<1.5) step=1*mag; else if(norm<3) step=2*mag; else if(norm<7) step=5*mag; else step=10*mag;
    var out=[], start=Math.ceil(lo/step)*step;
    for(var v=start;v<=hi+step*0.5;v+=step) out.push(Math.round(v*1e6)/1e6);
    return out;
  }
  function computeTrailingAvg(prices,ts,windowDays){
    var out=[],sum=0,ws=0,wms=windowDays*864e5;
    for(var i=0;i<prices.length;i++){
      sum+=prices[i];
      while(ts[i]-ts[ws]>wms){ sum-=prices[ws]; ws++; }
      out.push(sum/(i-ws+1));
    }
    return out;
  }

  var BB_PERIOD=20, BB_MULT=2;
  function computeBollingerBands(prices,period,mult){
    var sma=[],upper=[],lower=[];
    var sum=0,sumSq=0,q=[];
    for(var i=0;i<prices.length;i++){
      q.push(prices[i]); sum+=prices[i]; sumSq+=prices[i]*prices[i];
      if(q.length>period){ var out=q.shift(); sum-=out; sumSq-=out*out; }
      var mean=sum/q.length;
      var variance=Math.max(0,sumSq/q.length-mean*mean);
      var sd=Math.sqrt(variance);
      sma.push(mean); upper.push(mean+mult*sd); lower.push(mean-mult*sd);
    }
    return {sma:sma,upper:upper,lower:lower};
  }
  function findDips(ts,dev,threshold){
    var dips=[],i=0;
    while(i<ts.length){
      if(dev[i]<=threshold){
        var start=i,minDev=dev[i],minIdx=i;
        while(i<ts.length && dev[i]<=threshold){ if(dev[i]<minDev){minDev=dev[i];minIdx=i;} i++; }
        dips.push({startIdx:start,endIdx:i-1,minDev:minDev,minIdx:minIdx});
      } else i++;
    }
    return dips;
  }

  function renderDCA(){
    var ticker=dcaSelected; if(!ticker) return;
    var hist=DCA_HISTORY[ticker]; if(!hist||!hist.length) return;
    var isUSD=TICKER_CURRENCY[ticker]==="USD";
    var fmt=isUSD?usd:eur;
    var prices=hist.map(function(h){ return isUSD?h.priceUSD:h.priceEUR; });
    var ts=hist.map(function(h){ return h.ts; });
    var avg=computeTrailingAvg(prices,ts,DCA_WINDOW_DAYS);
    var dev=prices.map(function(p,i){ return p/avg[i]-1; });
    var m=hist.length-1;

    // stats over the trailing DCA_WINDOW_DAYS from the latest point
    var cutoff=ts[m]-DCA_WINDOW_DAYS*864e5;
    var w0=0; while(w0<m && ts[w0]<cutoff) w0++;
    var winDev=dev.slice(w0), winTs=ts.slice(w0);
    var belowCount=winDev.filter(function(d){ return d<0; }).length;
    var belowPct=belowCount/winDev.length;
    var belowVals=winDev.filter(function(d){ return d<0; });
    var avgDiscount=belowVals.length?belowVals.reduce(function(a,b){return a+b;},0)/belowVals.length:0;
    var deepestIdx=w0; for(var i=w0;i<=m;i++) if(dev[i]<dev[deepestIdx]) deepestIdx=i;
    // the same statistic in the other direction: a stretch well above the trailing
    // average is where a take-profit rule would have been earning its keep
    var highestIdx=w0; for(var i=w0;i<=m;i++) if(dev[i]>dev[highestIdx]) highestIdx=i;

    function kpi(k){ return '<div class="kpi"><div class="k-label">'+k.l+'</div><div class="k-val">'+k.v+'</div>'+(k.s?'<div class="k-sub '+(k.c||"")+'">'+k.s+'</div>':'')+'</div>'; }
    document.getElementById("dca-kpi").innerHTML=[
      {l:"Current price", v:fmt(prices[m]), s:hist[m].date},
      {l:ntv()+"-day trailing average", v:fmt(avg[m])},
      {l:"Current deviation", v:dp(dev[m]), c:dev[m]<0?"pos":"neg", s:dev[m]<0?"trading below its own average":"trading above its own average"},
      {l:"Days below average", v:belowCount+" / "+winDev.length, s:comma((belowPct*100).toFixed(0))+"% of the last "+ntv()+" days"},
      {l:"Average discount when below", v:belowVals.length?dp(avgDiscount):"—", s:"typical dip size in the window"},
      {l:"Deepest discount", v:dp(dev[deepestIdx]), c:"pos", s:hist[deepestIdx].date},
      {l:"Highest premium", v:dp(dev[highestIdx]), c:"neg", s:hist[highestIdx].date}
    ].map(kpi).join("");
    function ntv(){ return Math.round((ts[m]-winTs[0])/864e5); }

    document.getElementById("dca-h1").textContent="Price vs. trailing average · "+tickerLabel(ticker);

    /* --- price + average chart --- */
    var svg=document.getElementById("dca-price");
    while(svg.firstChild) svg.removeChild(svg.firstChild);
    var W=960,H=320,l=66,r=100,tp=20,bt=34,pW=W-l-r,pH=H-tp-bt;
    var t0=ts[0],t1=ts[m];
    var vmax=Math.max.apply(null,prices),vmin=Math.min.apply(null,prices);
    var tks=niceTicksGeneric(vmin*0.98,vmax*1.02,5),yhi=Math.max(tks[tks.length-1],vmax*1.02),ylo=Math.min(tks[0],vmin*0.98);
    function X(i){ return l+(ts[i]-t0)/((t1-t0)||1)*pW; }
    function Y(v){ return tp+(1-(v-ylo)/((yhi-ylo)||1))*pH; }
    tks.forEach(function(t){ var y=Y(t);
      svg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5}); lb.textContent=fmt(t); svg.appendChild(lb);
    });
    var yrTicks=[]; var yStart=new Date(t0).getFullYear(), yEnd=new Date(t1).getFullYear();
    for(var yy=yStart;yy<=yEnd;yy++){ var yt=new Date(yy,0,1).getTime(); if(yt>=t0 && yt<=t1) yrTicks.push({t:yt,lab:String(yy)}); }
    yrTicks.forEach(function(yt){ var x=l+(yt.t-t0)/((t1-t0)||1)*pW;
      svg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:tp,y2:tp+pH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:tp+pH+20}); lb.textContent=yt.lab; svg.appendChild(lb);
    });
    var pp="",pa="";
    for(var i=0;i<hist.length;i++){
      pp+=(i?" L ":"M ")+X(i).toFixed(1)+" "+Y(prices[i]).toFixed(1);
      pa+=(i?" L ":"M ")+X(i).toFixed(1)+" "+Y(avg[i]).toFixed(1);
    }
    svg.appendChild(el("path",{class:"serieline",d:pa,stroke:"var(--muted)","stroke-dasharray":"4 3"}));
    svg.appendChild(el("path",{class:"serieline",d:pp,stroke:"var(--accent)"}));
    placeEndLabels(svg,W-r+8,[
      {y:Y(prices[m]), fill:"var(--accent)", text:"Price "+fmt(prices[m])},
      {y:Y(avg[m]),    fill:"var(--muted)",  text:"Avg "+fmt(avg[m])}
    ]);

    // Mark each of your own buy/sell transactions on the chart, at the price actually paid/received
    var priceTip=document.getElementById("dca-price-tip"), priceBox=svg.parentNode;
    (transactions||[]).filter(function(t){ return t.ticker===ticker && t.ts>=t0 && t.ts<=t1; }).forEach(function(t){
      var isSell=t.type==="sell";
      var perShareEUR=t.quantity?t.amount/t.quantity:0;
      var perShare=isUSD?(t.exchangeRate?perShareEUR/t.exchangeRate:perShareEUR):perShareEUR;
      var mx=l+(t.ts-t0)/((t1-t0)||1)*pW;
      var my=Y(Math.max(ylo,Math.min(yhi,perShare)));
      var dot=el("circle",{cx:mx.toFixed(1),cy:my.toFixed(1),r:5,fill:isSell?"var(--neg)":"var(--pos)",stroke:"var(--surface)","stroke-width":1.5,style:"cursor:pointer"});
      dot.addEventListener("pointerenter",function(){
        priceTip.innerHTML='<div class="th">'+(isSell?"Sell":"Buy")+" &middot; "+new Date(t.ts).toISOString().slice(0,10)+'</div>'+
          '<div class="row"><span class="lab"><i style="background:'+(isSell?"var(--neg)":"var(--pos)")+'"></i>Quantity</span><span class="v">'+t.quantity+' shares</span></div>'+
          '<div class="row"><span class="lab">Price</span><span class="v">'+fmt(perShare)+'</span></div>';
        priceTip.classList.add("on");
        var relX=mx/W*priceBox.clientWidth, tw=priceTip.offsetWidth;
        priceTip.style.left=Math.max(tw/2+4,Math.min(priceBox.clientWidth-tw/2-4,relX))+"px";
        priceTip.style.top=(my/H*priceBox.clientHeight-priceTip.offsetHeight-12)+"px";
      });
      dot.addEventListener("pointerleave",function(){ priceTip.classList.remove("on"); });
      svg.appendChild(dot);
    });

    /* --- Bollinger Bands chart --- */
    var bb=computeBollingerBands(prices,BB_PERIOD,BB_MULT);
    document.getElementById("dca-bb-h").textContent="Bollinger Bands ("+BB_PERIOD+"-day, ±"+BB_MULT+"σ) · "+tickerLabel(ticker);
    var bsvg=document.getElementById("dca-bb");
    while(bsvg.firstChild) bsvg.removeChild(bsvg.firstChild);
    var bvmax=Math.max.apply(null,bb.upper),bvmin=Math.min.apply(null,bb.lower);
    var btks=niceTicksGeneric(bvmin*0.98,bvmax*1.02,5),byhi=Math.max(btks[btks.length-1],bvmax*1.02),bylo=Math.min(btks[0],bvmin*0.98);
    function BY(v){ return tp+(1-(v-bylo)/((byhi-bylo)||1))*pH; }
    btks.forEach(function(t){ var y=BY(t);
      bsvg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5}); lb.textContent=fmt(t); bsvg.appendChild(lb);
    });
    yrTicks.forEach(function(yt){ var x=l+(yt.t-t0)/((t1-t0)||1)*pW;
      bsvg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:tp,y2:tp+pH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:tp+pH+20}); lb.textContent=yt.lab; bsvg.appendChild(lb);
    });
    var bUp="",bLo="",bMid="",bBand="M ";
    for(var i=0;i<hist.length;i++){
      var x=X(i);
      bUp+=(i?" L ":"M ")+x.toFixed(1)+" "+BY(bb.upper[i]).toFixed(1);
      bLo+=(i?" L ":"M ")+x.toFixed(1)+" "+BY(bb.lower[i]).toFixed(1);
      bMid+=(i?" L ":"M ")+x.toFixed(1)+" "+BY(bb.sma[i]).toFixed(1);
      bBand+=(i?" L ":"")+x.toFixed(1)+" "+BY(bb.upper[i]).toFixed(1);
    }
    for(var i=hist.length-1;i>=0;i--){ bBand+=" L "+X(i).toFixed(1)+" "+BY(bb.lower[i]).toFixed(1); }
    bBand+=" Z";
    bsvg.appendChild(el("path",{d:bBand,fill:"var(--accent)",opacity:.08,stroke:"none"}));
    bsvg.appendChild(el("path",{class:"serieline",d:bUp,stroke:"var(--muted)","stroke-width":1.3,"stroke-dasharray":"4 3"}));
    bsvg.appendChild(el("path",{class:"serieline",d:bLo,stroke:"var(--muted)","stroke-width":1.3,"stroke-dasharray":"4 3"}));
    bsvg.appendChild(el("path",{class:"serieline",d:bMid,stroke:"var(--faint)","stroke-width":1.3}));
    var bPrice=""; for(var i=0;i<hist.length;i++){ bPrice+=(i?" L ":"M ")+X(i).toFixed(1)+" "+BY(prices[i]).toFixed(1); }
    bsvg.appendChild(el("path",{class:"serieline",d:bPrice,stroke:"var(--accent)"}));
    var bTouch=m; for(var i=m;i>=0 && i>m-90;i--){ if(prices[i]<=bb.lower[i]){ bTouch=i; break; } }
    if(prices[bTouch]<=bb.lower[bTouch]) bsvg.appendChild(el("circle",{cx:X(bTouch),cy:BY(prices[bTouch]),r:3.5,fill:"var(--pos)",stroke:"var(--surface)","stroke-width":1.5}));
    var bbEnds=[
      {y:BY(bb.upper[m]), fill:"var(--muted)", text:"Upper "+fmt(bb.upper[m])},
      {y:BY(bb.lower[m]), fill:"var(--muted)", text:"Lower "+fmt(bb.lower[m])}
    ];
    bbEnds.push({y:BY(prices[m]), fill:"var(--accent)", text:"Price "+fmt(prices[m])});
    placeEndLabels(bsvg,W-r+8,bbEnds);
    var bbTip=document.getElementById("dca-bb-tip"), bBox=bsvg.parentNode;
    var bCross=el("line",{class:"crosshair",x1:0,x2:0,y1:tp,y2:tp+pH,opacity:0}); bsvg.appendChild(bCross);
    bsvg.appendChild(el("rect",{x:l,y:tp,width:pW,height:pH,fill:"transparent"}));
    function bNear(cx){ var rr=bsvg.getBoundingClientRect(), px=(cx-rr.left)/rr.width*W, b=0,bd=1e9; for(var i=0;i<hist.length;i++){var d=Math.abs(X(i)-px); if(d<bd){bd=d;b=i;}} return b; }
    function bShow(i){
      var x=X(i);
      bCross.setAttribute("x1",x); bCross.setAttribute("x2",x); bCross.setAttribute("opacity",1);
      bbTip.innerHTML='<div class="th">'+hist[i].date+'</div>'+
        '<div class="row"><span class="lab"><i style="background:var(--accent)"></i>Price</span><span class="v">'+fmt(prices[i])+'</span></div>'+
        '<div class="row"><span class="lab">Upper band</span><span class="v">'+fmt(bb.upper[i])+'</span></div>'+
        '<div class="row"><span class="lab">Middle (SMA'+BB_PERIOD+')</span><span class="v">'+fmt(bb.sma[i])+'</span></div>'+
        '<div class="row"><span class="lab">Lower band</span><span class="v">'+fmt(bb.lower[i])+'</span></div>';
      bbTip.classList.add("on");
      var relX=x/W*bBox.clientWidth, tw=bbTip.offsetWidth;
      bbTip.style.left=Math.max(tw/2+4,Math.min(bBox.clientWidth-tw/2-4,relX))+"px";
      bbTip.style.top=(BY(prices[i])/H*bBox.clientHeight-bbTip.offsetHeight-12)+"px";
    }
    function bHide(){ bbTip.classList.remove("on"); bCross.setAttribute("opacity",0); }
    bsvg.onpointermove=function(e){ bShow(bNear(e.clientX)); };
    bsvg.onpointerdown=function(e){ bShow(bNear(e.clientX)); };
    bsvg.onpointerleave=bHide;

    /* --- deviation chart --- */
    var dsvg=document.getElementById("dca-dev");
    while(dsvg.firstChild) dsvg.removeChild(dsvg.firstChild);
    var dmin=Math.min.apply(null,dev)*1.08, dmax=Math.max(0.02,Math.max.apply(null,dev)*1.08);
    var dspan=Math.max(Math.abs(dmin),dmax);
    var stepd = dspan>1.2 ? 0.25 : dspan>0.6 ? 0.2 : dspan>0.32 ? 0.1 : 0.05;
    function DX(i){ return l+(ts[i]-t0)/((t1-t0)||1)*pW; }
    function DY(v){ return tp+(1-(v-dmin)/((dmax-dmin)||1))*pH; }
    for(var t=0;t>=dmin-1e-9;t-=stepd){ var y=DY(t);
      dsvg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5}); lb.textContent=Math.round(t*100)+"%"; dsvg.appendChild(lb);
    }
    for(var t=stepd;t<=dmax+1e-9;t+=stepd){ var y=DY(t);
      dsvg.appendChild(el("line",{class:"gridline",x1:l,x2:W-r,y1:y,y2:y}));
      var lb=el("text",{class:"axislbl","text-anchor":"end",x:l-10,y:y+3.5}); lb.textContent="+"+Math.round(t*100)+"%"; dsvg.appendChild(lb);
    }
    yrTicks.forEach(function(yt){ var x=l+(yt.t-t0)/((t1-t0)||1)*pW;
      dsvg.appendChild(el("line",{class:"gridline",x1:x,x2:x,y1:tp,y2:tp+pH,"stroke-dasharray":"2 3"}));
      var lb=el("text",{class:"xlbl",x:x,y:tp+pH+20}); lb.textContent=yt.lab; dsvg.appendChild(lb);
    });
    var dl="";
    for(var i=0;i<hist.length;i++){ dl+=(i?" L ":"M ")+DX(i).toFixed(1)+" "+DY(dev[i]).toFixed(1); }
    dsvg.appendChild(el("path",{class:"uw-area",d:"M "+DX(0).toFixed(1)+" "+DY(0).toFixed(1)+" L "+dl.slice(2)+" L "+DX(m).toFixed(1)+" "+DY(0).toFixed(1)+" Z"}));
    dsvg.appendChild(el("path",{class:"uw-line",d:dl}));
    dsvg.appendChild(el("line",{x1:l,x2:W-r,y1:DY(0),y2:DY(0),stroke:"var(--hair)","stroke-width":1}));
    dsvg.appendChild(el("circle",{cx:DX(deepestIdx),cy:DY(dev[deepestIdx]),r:3.5,fill:"var(--pos)",stroke:"var(--surface)","stroke-width":1.5}));
    var nLab=el("text",{class:"endlbl",x:W-r+8,y:DY(dev[m])+3.5,fill:dev[m]<0?"var(--pos)":"var(--neg)"}); nLab.textContent="now "+dp(dev[m]); dsvg.appendChild(nLab);
    var dTip=document.getElementById("dca-tip"), dBox=dsvg.parentNode;
    var dCross=el("line",{class:"crosshair",x1:0,x2:0,y1:tp,y2:tp+pH,opacity:0}); dsvg.appendChild(dCross);
    dsvg.appendChild(el("rect",{x:l,y:tp,width:pW,height:pH,fill:"transparent"}));
    function dNear(cx){ var rr=dsvg.getBoundingClientRect(), px=(cx-rr.left)/rr.width*W, b=0,bd=1e9; for(var i=0;i<hist.length;i++){var d=Math.abs(DX(i)-px); if(d<bd){bd=d;b=i;}} return b; }
    function dShow(i){
      var x=DX(i);
      dCross.setAttribute("x1",x); dCross.setAttribute("x2",x); dCross.setAttribute("opacity",1);
      dTip.innerHTML='<div class="th">'+hist[i].date+'</div>'+
        '<div class="row"><span class="lab">Price</span><span class="v">'+fmt(prices[i])+'</span></div>'+
        '<div class="row"><span class="lab">Trailing avg</span><span class="v">'+fmt(avg[i])+'</span></div>'+
        '<div class="row"><span class="lab">Deviation</span><span class="v">'+dp(dev[i])+'</span></div>';
      dTip.classList.add("on");
      var relX=x/W*dBox.clientWidth, tw=dTip.offsetWidth;
      dTip.style.left=Math.max(tw/2+4,Math.min(dBox.clientWidth-tw/2-4,relX))+"px";
      dTip.style.top=(DY(dev[i])/H*dBox.clientHeight-dTip.offsetHeight-12)+"px";
    }
    function dHide(){ dTip.classList.remove("on"); dCross.setAttribute("opacity",0); }
    dsvg.onpointermove=function(e){ dShow(dNear(e.clientX)); };
    dsvg.onpointerdown=function(e){ dShow(dNear(e.clientX)); };
    dsvg.onpointerleave=dHide;

    /* --- notable dips table --- */
    var dips=findDips(ts,dev,DCA_DIP_THRESHOLD).sort(function(a,b){ return b.startIdx-a.startIdx; }).slice(0,10);
    var tbl=document.getElementById("dca-table");
    if(!dips.length){
      tbl.innerHTML='<tbody><tr><td style="padding:12px;color:var(--faint)">No dip of '+Math.round(Math.abs(DCA_DIP_THRESHOLD)*100)+'%+ below average found in this window.</td></tr></tbody>';
    } else {
      tbl.innerHTML='<thead><tr><th>Period</th><th>Duration</th><th>Deepest discount</th><th>On</th></tr></thead><tbody>'+
        dips.map(function(d){
          var ongoing=d.endIdx===m;
          var period=hist[d.startIdx].date+" → "+(ongoing?"now":hist[d.endIdx].date);
          var days=Math.round((ts[d.endIdx]-ts[d.startIdx])/864e5)+1;
          return '<tr><td>'+period+'</td><td>'+days+' days</td><td class="pos">'+dp(d.minDev)+'</td><td>'+hist[d.minIdx].date+'</td></tr>';
        }).join("")+'</tbody>';
    }
  }

  /* ================= fetch snapshots from API ================= */
  function loadSnapshotsFromAPI() {
    return apiFetch('./api/snapshots')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(data => {
        if (!data.snapshots || data.snapshots.length === 0) {
          // A new account has no transactions yet. That is the normal starting
          // state, not a failure — showing a red error to someone who has just
          // signed up is both alarming and unhelpful, so point them at the step
          // they actually need to take.
          console.info('No snapshots yet — account has no transactions');
          BASE_RAW=[]; CURRENT_MARKET_VALUE=null; CURRENT_COST_BASIS=null;
          toast('Add your first transaction to start building your portfolio history');
          return [];
        }

        // Transform API snapshots to BASE_RAW format: [dateStr, [[tickerIdx, qty, marketValue, rent]]]
        // Transform API snapshots to BASE_RAW format: [dateStr, [[tickerIdx, qty, marketValue, rent]]]
        BASE_RAW = data.snapshots
          .filter(snap => snap.holdings && snap.holdings.length > 0 && snap.ts)
          .map(snap => {
            // snap.date is a UTC instant. Stripping the Z and re-parsing made the
            // browser read it as local time, moving every point back by the viewer's
            // offset — and since the server stamps each snapshot at local midnight,
            // that put the last one on the previous day: "Last updated: 9 Sept" above
            // a chart holding the 10 Sept close. Keep the instant as sent.
            const dateStr = snap.date;
            const holdings = snap.holdings.map(h => {
              // BKEY started as a fixed list of the tickers held at the time it was
              // written. Anything absent used to be dropped here, silently removing
              // the holding from both the chart and the headline total — an ASML.AS
              // and a VOW3.DE position worth €3,567 disappeared with no warning.
              // Register unknown tickers instead, so a newly bought holding shows up
              // rather than quietly going missing.
              const key = h.ticker.toLowerCase();
              let tickerIdx = BKEY.indexOf(key);
              if (tickerIdx === -1) {
                const label = TICKER_NAMES[h.ticker.toUpperCase()] || h.ticker.toUpperCase();
                // Series downstream are keyed by company name, so appending a second
                // entry called "ASML Holding" for ASML.AS counted that holding twice.
                // A suffixed symbol is the same company on a different exchange: reuse
                // its existing slot, and only create one for a genuinely new company.
                const existing = BNAMES.indexOf(label);
                if (existing !== -1) {
                  tickerIdx = existing;
                } else {
                  BKEY.push(key);
                  BNAMES.push(label);
                  BSHORT.push(label.length > 11 ? label.slice(0, 11) : label);
                  tickerIdx = BKEY.length - 1;
                }
              }
              return [tickerIdx, h.quantity, h.marketValue, null];
            }).filter(h => h !== null);

            if (holdings.length === 0) return null;
            return [dateStr, holdings];
          })
          .filter(s => s !== null);

        // Market value and cost basis come from the last snapshot. They used to be read
        // from /api/prices, which has never returned snapshots — so the gain line beside
        // the headline was dead for every account since it was written.
        var last=data.snapshots[data.snapshots.length-1];
        if(last){
          if(last.portfolioTotal!=null) CURRENT_MARKET_VALUE=last.portfolioTotal;
          if(last.costBasis!=null) CURRENT_COST_BASIS=last.costBasis;
        }

        console.log(`✓ Loaded ${BASE_RAW.length} snapshots from API`);
        return BASE_RAW;
      })
      .catch(err => {
        console.error('Failed to load snapshots:', err.message);
        showError('Failed to load portfolio data: '+err.message);
        return [];
      });
  }

  /* Every series on the page is derived from BASE_RAW, and only /api/snapshots fills
     it. rebuild() on its own therefore redraws the same stale numbers — which is why
     registering or deleting a transaction left the chart a page-reload behind the very
     list it sits next to. Re-fetch, then rebuild. */
  function refreshPortfolio(){
    return loadSnapshotsFromAPI().then(function(rows){
      if(rows && rows.length){ rebuild(); return; }
      // No snapshots and no transactions means the last holding was just deleted.
      // rebuild() cannot draw a universe with nothing in it; startApp already handles
      // that state properly, so hand back to it rather than special-casing every chart.
      if(!transactions.length) location.reload();
    });
  }

  /* ================= fetch stock splits from API ================= */
  function loadStockSplits() {
    return apiFetch('./api/stock-splits')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(data => {
        if (!data.splits || !Array.isArray(data.splits)) {
          console.warn('No stock splits from API');
          return [];
        }
        STOCK_SPLITS = data.splits;
        console.log(`✓ Loaded ${STOCK_SPLITS.length} stock splits`);
        renderEventsTimeline();
        return STOCK_SPLITS;
      })
      .catch(err => {
        console.error('Failed to load stock splits:', err.message);
        return [];
      });
  }

  /* ================= go ================= */
  function hideLoadingOverlay(){
    var overlay=document.getElementById("loading-overlay");
    if(overlay) setTimeout(function(){ overlay.style.opacity="0"; overlay.style.pointerEvents="none"; }, 300);
  }

  function startApp(){
    return Promise.all([loadSnapshotsFromAPI(), loadStockSplits()]).then(() => {
      rebuild();
      document.getElementById("tx-date").value=todayISO();
      loadTransactions();
      loadAndRenderPrices();
      hideLoadingOverlay();
    }).catch(function(err){
      // this used to swallow the error, so a crash mid-render looked like an empty page
      console.error('startApp failed:', err && err.stack || err);
      hideLoadingOverlay();
    });
  }

  /* --- auth gate wiring --- */
  document.getElementById("auth-form").addEventListener("submit",function(e){
    e.preventDefault();
    var nt=document.getElementById("auth-note"); nt.className="frm-note"; nt.textContent="";
    var email=(document.getElementById("auth-email").value||"").trim();
    if(!email){ nt.textContent="Enter your email address."; return; }

    var btn=document.getElementById("auth-submit");
    btn.disabled=true; btn.textContent="Sending…";
    fetch("./api/auth/request-link",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"same-origin",
      body:JSON.stringify({email:email})
    }).then(function(r){ return r.json(); }).then(function(data){
      document.getElementById("auth-sent-msg").textContent=data.message||"Check your email for the login link.";
      document.getElementById("auth-form").hidden=true;
      document.getElementById("auth-sent").hidden=false;
    }).catch(function(){
      nt.className="frm-note err";
      nt.textContent="Could not send the link. Please try again.";
    }).finally(function(){
      btn.disabled=false; btn.textContent="Send me a login link";
    });
  });

  document.getElementById("auth-back").addEventListener("click",function(){
    document.getElementById("auth-sent").hidden=true;
    document.getElementById("auth-form").hidden=false;
    document.getElementById("auth-email").focus();
  });

  // Only offer Google sign-in if the server actually has credentials for it.
  function loadAuthConfig(){
    return fetch("./api/auth/config",{credentials:"same-origin"})
      .then(function(r){ return r.ok?r.json():{}; })
      .then(function(cfg){
        if(cfg && cfg.google) document.getElementById("auth-google-wrap").hidden=false;
      })
      .catch(function(){ /* leave Google hidden */ });
  }

  // Boot: confirm a session before loading anything, otherwise show the gate.
  fetch("./api/auth/me",{credentials:"same-origin"})
    .then(function(r){ return r.ok?r.json():null; })
    .then(function(user){
      if(!user){ hideLoadingOverlay(); loadAuthConfig(); showAuthGate(); return; }
      currentUser=user;
      hideAuthGate();
      renderAuthStatus();
      return startApp();
    })
    .catch(function(){ hideLoadingOverlay(); loadAuthConfig(); showAuthGate(); });

  /* ================= Contact Form ================= */
})();
