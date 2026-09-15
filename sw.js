const CACHE="ubereats-progress-v68";
const ASSETS=["./?v=68","index.html?v=68","styles/main.css?v=68","styles/appearance.css?v=68","src/appearance.js?v=68","assets/ui-icons.svg?v=68","src/app-core.js?v=68","src/quest-store.js?v=68","src/quest-image.js?v=68","src/quest-ui.js?v=68","styles/quest.css?v=68","src/main-app.js?v=68","src/session-engine.js?v=68","src/session-editors.js?v=68","compact.html?v=68","styles/compact.css?v=68","src/compact-app.js?v=68","manifest.webmanifest","apple-touch-icon.png","assets/favicon-32.png","assets/icon-192.png","assets/icon-512.png","assets/delivery-scooter.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

function isMainPage(request){
  const url=new URL(request.url);
  return request.mode==="navigate"&&(url.pathname.endsWith("/")||url.pathname.endsWith("/index.html"));
}

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET")return;
  event.respondWith((async()=>{
    try{
      const cached=await caches.match(event.request,{ignoreSearch:true});
      let response=cached;
      if(!response){
        response=await fetch(event.request);
        if(response&&response.ok&&response.type==="basic"){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy));
        }
      }
      return response;
    }catch(_){
      const fallback=await caches.match("index.html",{ignoreSearch:true});
      if(isMainPage(event.request)&&fallback)return fallback;
      throw _;
    }
  })());
});
