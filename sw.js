const CACHE="ubereats-progress-v65";
const ASSETS=["./?v=65","index.html?v=65","styles/main.css?v=65","styles/appearance.css?v=65","src/appearance.js?v=65","assets/ui-icons.svg?v=65","src/app-core.js?v=65","src/quest-store.js?v=65","src/quest-ui.js?v=65","styles/quest.css?v=65","src/main-app.js?v=65","src/session-engine.js?v=65","src/session-editors.js?v=65","compact.html?v=65","styles/compact.css?v=65","src/compact-app.js?v=65","manifest.webmanifest","apple-touch-icon.png","assets/favicon-32.png","assets/icon-192.png","assets/icon-512.png","assets/delivery-scooter.png"];

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
