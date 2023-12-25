/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 2.1.2 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */

/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 2.1.10 Copyright (c) 2010-2014, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
var requirejs,require,define;(function(global){var req,s,head,baseElement,dataMain,src,interactiveScript,currentlyAddingScript,mainScript,subPath,version="2.1.10",commentRegExp=/(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/gm,cjsRequireRegExp=/[^.]\s*require\s*\(\s*["']([^'"\s]+)["']\s*\)/g,jsSuffixRegExp=/\.js$/,currDirRegExp=/^\.\//,op=Object.prototype,ostring=op.toString,hasOwn=op.hasOwnProperty,ap=Array.prototype,apsp=ap.splice,isBrowser=!("undefined"==typeof window||"undefined"==typeof navigator||!window.document),isWebWorker=!isBrowser&&"undefined"!=typeof importScripts,readyRegExp=isBrowser&&"PLAYSTATION 3"===navigator.platform?/^complete$/:/^(complete|loaded)$/,defContextName="_",isOpera="undefined"!=typeof opera&&"[object Opera]"===opera.toString(),contexts={},cfg={},globalDefQueue=[],useInteractive=!1;function isFunction(e){return"[object Function]"===ostring.call(e)}function isArray(e){return"[object Array]"===ostring.call(e)}function each(e,t){var i;if(e)for(i=0;i<e.length&&(!e[i]||!t(e[i],i,e));i+=1);}function eachReverse(e,t){var i;if(e)for(i=e.length-1;i>-1&&(!e[i]||!t(e[i],i,e));i-=1);}function hasProp(e,t){return hasOwn.call(e,t)}function getOwn(e,t){return hasProp(e,t)&&e[t]}function eachProp(e,t){var i;for(i in e)if(hasProp(e,i)&&t(e[i],i))break}function mixin(e,t,i,r){return t&&eachProp(t,(function(t,n){!i&&hasProp(e,n)||(!r||"object"!=typeof t||!t||isArray(t)||isFunction(t)||t instanceof RegExp?e[n]=t:(e[n]||(e[n]={}),mixin(e[n],t,i,r)))})),e}function bind(e,t){return function(){return t.apply(e,arguments)}}function scripts(){return document.getElementsByTagName("script")}function defaultOnError(e){throw e}function getGlobal(e){if(!e)return e;var t=global;return each(e.split("."),(function(e){t=t[e]})),t}function makeError(e,t,i,r){var n=new Error(t+"\nhttp://requirejs.org/docs/errors.html#"+e);return n.requireType=e,n.requireModules=r,i&&(n.originalError=i),n}if(void 0===define){if(void 0!==requirejs){if(isFunction(requirejs))return;cfg=requirejs,requirejs=void 0}void 0===require||isFunction(require)||(cfg=require,require=void 0),req=requirejs=function(e,t,i,r){var n,a,o=defContextName;return isArray(e)||"string"==typeof e||(a=e,isArray(t)?(e=t,t=i,i=r):e=[]),a&&a.context&&(o=a.context),(n=getOwn(contexts,o))||(n=contexts[o]=req.s.newContext(o)),a&&n.configure(a),n.require(e,t,i)},req.config=function(e){return req(e)},req.nextTick="undefined"!=typeof setTimeout?function(e){setTimeout(e,4)}:function(e){e()},require||(require=req),req.version=version,req.jsExtRegExp=/^\/|:|\?|\.js$/,req.isBrowser=isBrowser,s=req.s={contexts:contexts,newContext:newContext},req({}),each(["toUrl","undef","defined","specified"],(function(e){req[e]=function(){var t=contexts[defContextName];return t.require[e].apply(t,arguments)}})),isBrowser&&(head=s.head=document.getElementsByTagName("head")[0],baseElement=document.getElementsByTagName("base")[0],baseElement&&(head=s.head=baseElement.parentNode)),req.onError=defaultOnError,req.createNode=function(e,t,i){var r=e.xhtml?document.createElementNS("http://www.w3.org/1999/xhtml","html:script"):document.createElement("script");return r.type=e.scriptType||"text/javascript",r.charset="utf-8",r.async=!0,r},req.load=function(e,t,i){var r,n=e&&e.config||{};if(isBrowser)return(r=req.createNode(n,t,i)).setAttribute("data-requirecontext",e.contextName),r.setAttribute("data-requiremodule",t),!r.attachEvent||r.attachEvent.toString&&r.attachEvent.toString().indexOf("[native code")<0||isOpera?(r.addEventListener("load",e.onScriptLoad,!1),r.addEventListener("error",e.onScriptError,!1)):(useInteractive=!0,r.attachEvent("onreadystatechange",e.onScriptLoad)),r.src=i,currentlyAddingScript=r,baseElement?head.insertBefore(r,baseElement):head.appendChild(r),currentlyAddingScript=null,r;if(isWebWorker)try{importScripts(i),e.completeLoad(t)}catch(r){e.onError(makeError("importscripts","importScripts failed for "+t+" at "+i,r,[t]))}},isBrowser&&!cfg.skipDataMain&&eachReverse(scripts(),(function(e){if(head||(head=e.parentNode),dataMain=e.getAttribute("data-main"))return mainScript=dataMain,cfg.baseUrl||(src=mainScript.split("/"),mainScript=src.pop(),subPath=src.length?src.join("/")+"/":"./",cfg.baseUrl=subPath),mainScript=mainScript.replace(jsSuffixRegExp,""),req.jsExtRegExp.test(mainScript)&&(mainScript=dataMain),cfg.deps=cfg.deps?cfg.deps.concat(mainScript):[mainScript],!0})),define=function(e,t,i){var r,n;"string"!=typeof e&&(i=t,t=e,e=null),isArray(t)||(i=t,t=null),!t&&isFunction(i)&&(t=[],i.length&&(i.toString().replace(commentRegExp,"").replace(cjsRequireRegExp,(function(e,i){t.push(i)})),t=(1===i.length?["require"]:["require","exports","module"]).concat(t))),useInteractive&&(r=currentlyAddingScript||getInteractiveScript())&&(e||(e=r.getAttribute("data-requiremodule")),n=contexts[r.getAttribute("data-requirecontext")]),(n?n.defQueue:globalDefQueue).push([e,t,i])},define.amd={jQuery:!0},req.exec=function(text){return eval(text)},req(cfg)}function newContext(e){var t,i,r,n,a,o={waitSeconds:7,baseUrl:"./",paths:{},bundles:{},pkgs:{},shim:{},config:{}},s={},c={},u={},p=[],d={},f={},l={},h=1,m=1;function g(e,t,i){var r,n,a,s,c,u,p,d,f,l,h=t&&t.split("/"),m=h,g=o.map,v=g&&g["*"];if(e&&"."===e.charAt(0)&&(t?(m=h.slice(0,h.length-1),u=(e=e.split("/")).length-1,o.nodeIdCompat&&jsSuffixRegExp.test(e[u])&&(e[u]=e[u].replace(jsSuffixRegExp,"")),function(e){var t,i,r=e.length;for(t=0;t<r;t++)if("."===(i=e[t]))e.splice(t,1),t-=1;else if(".."===i){if(1===t&&(".."===e[2]||".."===e[0]))break;t>0&&(e.splice(t-1,2),t-=2)}}(e=m.concat(e)),e=e.join("/")):0===e.indexOf("./")&&(e=e.substring(2))),i&&g&&(h||v)){e:for(a=(n=e.split("/")).length;a>0;a-=1){if(c=n.slice(0,a).join("/"),h)for(s=h.length;s>0;s-=1)if((r=getOwn(g,h.slice(0,s).join("/")))&&(r=getOwn(r,c))){p=r,d=a;break e}!f&&v&&getOwn(v,c)&&(f=getOwn(v,c),l=a)}!p&&f&&(p=f,d=l),p&&(n.splice(0,d,p),e=n.join("/"))}return getOwn(o.pkgs,e)||e}function v(e){isBrowser&&each(scripts(),(function(t){if(t.getAttribute("data-requiremodule")===e&&t.getAttribute("data-requirecontext")===r.contextName)return t.parentNode.removeChild(t),!0}))}function x(e){var t=getOwn(o.paths,e);if(t&&isArray(t)&&t.length>1)return t.shift(),r.require.undef(e),r.require([e]),!0}function b(e){var t,i=e?e.indexOf("!"):-1;return i>-1&&(t=e.substring(0,i),e=e.substring(i+1,e.length)),[t,e]}function q(e,t,i,n){var a,o,s,c,u=null,p=t?t.name:null,f=e,l=!0,v="";return e||(l=!1,e="_@r"+(h+=1)),u=(c=b(e))[0],e=c[1],u&&(u=g(u,p,n),o=getOwn(d,u)),e&&(u?v=o&&o.normalize?o.normalize(e,(function(e){return g(e,p,n)})):g(e,p,n):(u=(c=b(v=g(e,p,n)))[0],v=c[1],i=!0,a=r.nameToUrl(v))),{prefix:u,name:v,parentMap:t,unnormalized:!!(s=!u||o||i?"":"_unnormalized"+(m+=1)),url:a,originalName:f,isDefine:l,id:(u?u+"!"+v:v)+s}}function E(e){var t=e.id,i=getOwn(s,t);return i||(i=s[t]=new r.Module(e)),i}function w(e,t,i){var r=e.id,n=getOwn(s,r);!hasProp(d,r)||n&&!n.defineEmitComplete?(n=E(e)).error&&"error"===t?i(n.error):n.on(t,i):"defined"===t&&i(d[r])}function y(e,t){var i=e.requireModules,r=!1;t?t(e):(each(i,(function(t){var i=getOwn(s,t);i&&(i.error=e,i.events.error&&(r=!0,i.emit("error",e)))})),r||req.onError(e))}function S(){globalDefQueue.length&&(apsp.apply(p,[p.length,0].concat(globalDefQueue)),globalDefQueue=[])}function k(e){delete s[e],delete c[e]}function O(e,t,i){var r=e.map.id;e.error?e.emit("error",e.error):(t[r]=!0,each(e.depMaps,(function(r,n){var a=r.id,o=getOwn(s,a);!o||e.depMatched[n]||i[a]||(getOwn(t,a)?(e.defineDep(n,d[a]),e.check()):O(o,t,i))})),i[r]=!0)}function M(){var e,i,n=1e3*o.waitSeconds,s=n&&r.startTime+n<(new Date).getTime(),u=[],p=[],d=!1,f=!0;if(!t){if(t=!0,eachProp(c,(function(e){var t=e.map,r=t.id;if(e.enabled&&(t.isDefine||p.push(e),!e.error))if(!e.inited&&s)x(r)?(i=!0,d=!0):(u.push(r),v(r));else if(!e.inited&&e.fetched&&t.isDefine&&(d=!0,!t.prefix))return f=!1})),s&&u.length)return(e=makeError("timeout","Load timeout for modules: "+u,null,u)).contextName=r.contextName,y(e);f&&each(p,(function(e){O(e,{},{})})),s&&!i||!d||!isBrowser&&!isWebWorker||a||(a=setTimeout((function(){a=0,M()}),50)),t=!1}}function j(e){hasProp(d,e[0])||E(q(e[0],null,!0)).init(e[1],e[2])}function P(e,t,i,r){e.detachEvent&&!isOpera?r&&e.detachEvent(r,t):e.removeEventListener(i,t,!1)}function R(e){var t=e.currentTarget||e.srcElement;return P(t,r.onScriptLoad,"load","onreadystatechange"),P(t,r.onScriptError,"error"),{node:t,id:t&&t.getAttribute("data-requiremodule")}}function A(){var e;for(S();p.length;){if(null===(e=p.shift())[0])return y(makeError("mismatch","Mismatched anonymous define() module: "+e[e.length-1]));j(e)}}return n={require:function(e){return e.require?e.require:e.require=r.makeRequire(e.map)},exports:function(e){if(e.usingExports=!0,e.map.isDefine)return e.exports?e.exports:e.exports=d[e.map.id]={}},module:function(e){return e.module?e.module:e.module={id:e.map.id,uri:e.map.url,config:function(){return getOwn(o.config,e.map.id)||{}},exports:n.exports(e)}}},(i=function(e){this.events=getOwn(u,e.id)||{},this.map=e,this.shim=getOwn(o.shim,e.id),this.depExports=[],this.depMaps=[],this.depMatched=[],this.pluginMaps={},this.depCount=0}).prototype={init:function(e,t,i,r){r=r||{},this.inited||(this.factory=t,i?this.on("error",i):this.events.error&&(i=bind(this,(function(e){this.emit("error",e)}))),this.depMaps=e&&e.slice(0),this.errback=i,this.inited=!0,this.ignore=r.ignore,r.enabled||this.enabled?this.enable():this.check())},defineDep:function(e,t){this.depMatched[e]||(this.depMatched[e]=!0,this.depCount-=1,this.depExports[e]=t)},fetch:function(){if(!this.fetched){this.fetched=!0,r.startTime=(new Date).getTime();var e=this.map;if(!this.shim)return e.prefix?this.callPlugin():this.load();r.makeRequire(this.map,{enableBuildCallback:!0})(this.shim.deps||[],bind(this,(function(){return e.prefix?this.callPlugin():this.load()})))}},load:function(){var e=this.map.url;f[e]||(f[e]=!0,r.load(this.map.id,e))},check:function(){if(this.enabled&&!this.enabling){var e,t,i=this.map.id,n=this.depExports,a=this.exports,o=this.factory;if(this.inited){if(this.error)this.emit("error",this.error);else if(!this.defining){if(this.defining=!0,this.depCount<1&&!this.defined){if(isFunction(o)){if(this.events.error&&this.map.isDefine||req.onError!==defaultOnError)try{a=r.execCb(i,o,n,a)}catch(t){e=t}else a=r.execCb(i,o,n,a);if(this.map.isDefine&&void 0===a&&((t=this.module)?a=t.exports:this.usingExports&&(a=this.exports)),e)return e.requireMap=this.map,e.requireModules=this.map.isDefine?[this.map.id]:null,e.requireType=this.map.isDefine?"define":"require",y(this.error=e)}else a=o;this.exports=a,this.map.isDefine&&!this.ignore&&(d[i]=a,req.onResourceLoad&&req.onResourceLoad(r,this.map,this.depMaps)),k(i),this.defined=!0}this.defining=!1,this.defined&&!this.defineEmitted&&(this.defineEmitted=!0,this.emit("defined",this.exports),this.defineEmitComplete=!0)}}else this.fetch()}},callPlugin:function(){var e=this.map,t=e.id,i=q(e.prefix);this.depMaps.push(i),w(i,"defined",bind(this,(function(i){var n,a,c,u=getOwn(l,this.map.id),p=this.map.name,d=this.map.parentMap?this.map.parentMap.name:null,f=r.makeRequire(e.parentMap,{enableBuildCallback:!0});return this.map.unnormalized?(i.normalize&&(p=i.normalize(p,(function(e){return g(e,d,!0)}))||""),w(a=q(e.prefix+"!"+p,this.map.parentMap),"defined",bind(this,(function(e){this.init([],(function(){return e}),null,{enabled:!0,ignore:!0})}))),void((c=getOwn(s,a.id))&&(this.depMaps.push(a),this.events.error&&c.on("error",bind(this,(function(e){this.emit("error",e)}))),c.enable()))):u?(this.map.url=r.nameToUrl(u),void this.load()):((n=bind(this,(function(e){this.init([],(function(){return e}),null,{enabled:!0})}))).error=bind(this,(function(e){this.inited=!0,this.error=e,e.requireModules=[t],eachProp(s,(function(e){0===e.map.id.indexOf(t+"_unnormalized")&&k(e.map.id)})),y(e)})),n.fromText=bind(this,(function(i,a){var s=e.name,c=q(s),u=useInteractive;a&&(i=a),u&&(useInteractive=!1),E(c),hasProp(o.config,t)&&(o.config[s]=o.config[t]);try{req.exec(i)}catch(e){return y(makeError("fromtexteval","fromText eval for "+t+" failed: "+e,e,[t]))}u&&(useInteractive=!0),this.depMaps.push(c),r.completeLoad(s),f([s],n)})),void i.load(e.name,f,n,o))}))),r.enable(i,this),this.pluginMaps[i.id]=i},enable:function(){c[this.map.id]=this,this.enabled=!0,this.enabling=!0,each(this.depMaps,bind(this,(function(e,t){var i,a,o;if("string"==typeof e){if(e=q(e,this.map.isDefine?this.map:this.map.parentMap,!1,!this.skipMap),this.depMaps[t]=e,o=getOwn(n,e.id))return void(this.depExports[t]=o(this));this.depCount+=1,w(e,"defined",bind(this,(function(e){this.defineDep(t,e),this.check()}))),this.errback&&w(e,"error",bind(this,this.errback))}i=e.id,a=s[i],hasProp(n,i)||!a||a.enabled||r.enable(e,this)}))),eachProp(this.pluginMaps,bind(this,(function(e){var t=getOwn(s,e.id);t&&!t.enabled&&r.enable(e,this)}))),this.enabling=!1,this.check()},on:function(e,t){var i=this.events[e];i||(i=this.events[e]=[]),i.push(t)},emit:function(e,t){each(this.events[e],(function(e){e(t)})),"error"===e&&delete this.events[e]}},r={config:o,contextName:e,registry:s,defined:d,urlFetched:f,defQueue:p,Module:i,makeModuleMap:q,nextTick:req.nextTick,onError:y,configure:function(e){e.baseUrl&&"/"!==e.baseUrl.charAt(e.baseUrl.length-1)&&(e.baseUrl+="/");var t=o.shim,i={paths:!0,bundles:!0,config:!0,map:!0};eachProp(e,(function(e,t){i[t]?(o[t]||(o[t]={}),mixin(o[t],e,!0,!0)):o[t]=e})),e.bundles&&eachProp(e.bundles,(function(e,t){each(e,(function(e){e!==t&&(l[e]=t)}))})),e.shim&&(eachProp(e.shim,(function(e,i){isArray(e)&&(e={deps:e}),!e.exports&&!e.init||e.exportsFn||(e.exportsFn=r.makeShimExports(e)),t[i]=e})),o.shim=t),e.packages&&each(e.packages,(function(e){var t;t=(e="string"==typeof e?{name:e}:e).name,e.location&&(o.paths[t]=e.location),o.pkgs[t]=e.name+"/"+(e.main||"main").replace(currDirRegExp,"").replace(jsSuffixRegExp,"")})),eachProp(s,(function(e,t){e.inited||e.map.unnormalized||(e.map=q(t))})),(e.deps||e.callback)&&r.require(e.deps||[],e.callback)},makeShimExports:function(e){return function(){var t;return e.init&&(t=e.init.apply(global,arguments)),t||e.exports&&getGlobal(e.exports)}},makeRequire:function(t,i){function a(o,c,u){var p,f;return i.enableBuildCallback&&c&&isFunction(c)&&(c.__requireJsBuild=!0),"string"==typeof o?isFunction(c)?y(makeError("requireargs","Invalid require call"),u):t&&hasProp(n,o)?n[o](s[t.id]):req.get?req.get(r,o,t,a):(p=q(o,t,!1,!0).id,hasProp(d,p)?d[p]:y(makeError("notloaded",'Module name "'+p+'" has not been loaded yet for context: '+e+(t?"":". Use require([])")))):(A(),r.nextTick((function(){A(),(f=E(q(null,t))).skipMap=i.skipMap,f.init(o,c,u,{enabled:!0}),M()})),a)}return i=i||{},mixin(a,{isBrowser:isBrowser,toUrl:function(e){var i,n=e.lastIndexOf("."),a=e.split("/")[0];return-1!==n&&(!("."===a||".."===a)||n>1)&&(i=e.substring(n,e.length),e=e.substring(0,n)),r.nameToUrl(g(e,t&&t.id,!0),i,!0)},defined:function(e){return hasProp(d,q(e,t,!1,!0).id)},specified:function(e){return e=q(e,t,!1,!0).id,hasProp(d,e)||hasProp(s,e)}}),t||(a.undef=function(e){S();var i=q(e,t,!0),r=getOwn(s,e);v(e),delete d[e],delete f[i.url],delete u[e],eachReverse(p,(function(t,i){t[0]===e&&p.splice(i,1)})),r&&(r.events.defined&&(u[e]=r.events),k(e))}),a},enable:function(e){getOwn(s,e.id)&&E(e).enable()},completeLoad:function(e){var t,i,r,n=getOwn(o.shim,e)||{},a=n.exports;for(S();p.length;){if(null===(i=p.shift())[0]){if(i[0]=e,t)break;t=!0}else i[0]===e&&(t=!0);j(i)}if(r=getOwn(s,e),!t&&!hasProp(d,e)&&r&&!r.inited){if(!(!o.enforceDefine||a&&getGlobal(a)))return x(e)?void 0:y(makeError("nodefine","No define call for "+e,null,[e]));j([e,n.deps||[],n.exportsFn])}M()},nameToUrl:function(e,t,i){var n,a,s,c,u,p,d=getOwn(o.pkgs,e);if(d&&(e=d),p=getOwn(l,e))return r.nameToUrl(p,t,i);if(req.jsExtRegExp.test(e))c=e+(t||"");else{for(n=o.paths,s=(a=e.split("/")).length;s>0;s-=1)if(u=getOwn(n,a.slice(0,s).join("/"))){isArray(u)&&(u=u[0]),a.splice(0,s,u);break}c=a.join("/"),c=("/"===(c+=t||(/^data\:|\?/.test(c)||i?"":".js")).charAt(0)||c.match(/^[\w\+\.\-]+:/)?"":o.baseUrl)+c}return o.urlArgs?c+(-1===c.indexOf("?")?"?":"&")+o.urlArgs:c},load:function(e,t){req.load(r,e,t)},execCb:function(e,t,i,r){return t.apply(r,i)},onScriptLoad:function(e){if("load"===e.type||readyRegExp.test((e.currentTarget||e.srcElement).readyState)){interactiveScript=null;var t=R(e);r.completeLoad(t.id)}},onScriptError:function(e){var t=R(e);if(!x(t.id))return y(makeError("scripterror","Script error for: "+t.id,e,[t.id]))}},r.require=r.makeRequire(),r}function getInteractiveScript(){return interactiveScript&&"interactive"===interactiveScript.readyState||eachReverse(scripts(),(function(e){if("interactive"===e.readyState)return interactiveScript=e})),interactiveScript}})(this);