const CACHE="ubereats-progress-v75";
const ASSETS=["./?v=75","index.html?v=75","styles/main.css?v=75","styles/appearance.css?v=75","src/appearance.js?v=75","assets/ui-icons.svg?v=75","src/app-core.js?v=75","src/quest-store.js?v=75","src/quest-image.js?v=75","src/quest-ui.js?v=75","styles/quest.css?v=75","src/main-app.js?v=75","src/session-engine.js?v=75","src/session-editors.js?v=75","src/data-backup.js?v=75","compact.html?v=75","styles/compact.css?v=75","src/compact-app.js?v=75","manifest.webmanifest?v=10","apple-touch-icon.png?v=10","assets/favicon-32.png?v=10","assets/icon-192.png?v=10","assets/icon-512.png?v=10","assets/delivery-scooter.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));
});

// Pages are matched without their query so "./", "./?v=10" and "index.html" all
// open offline. Other files must match their ?v= exactly; a looser match is only
// an offline fallback, so a new page never silently runs an older script.
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET"||new URL(request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    if(request.mode==="navigate"){
      const page=await caches.match(request,{ignoreSearch:true});
      if(page)return page;
      try{return await fetch(request);}
      catch(error){
        const fallback=await caches.match("index.html",{ignoreSearch:true});
        if(fallback)return fallback;
        throw error;
      }
    }
    const exact=await caches.match(request);
    if(exact)return exact;
    try{
      const response=await fetch(request);
      if(response&&response.ok&&response.type==="basic"){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(request,copy));
      }
      return response;
    }catch(error){
      const fallback=await caches.match(request,{ignoreSearch:true});
      if(fallback)return fallback;
      throw error;
    }
  })());
});
