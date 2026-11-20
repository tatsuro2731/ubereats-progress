const CACHE="ubereats-progress-v100";
const ASSETS=["./?v=100","index.html?v=100","styles/main.css?v=100","styles/appearance.css?v=100","src/appearance.js?v=100","assets/ui-icons.svg?v=100","src/app-core.js?v=100","src/quest-store.js?v=100","src/quest-image.js?v=100","src/quest-image-crop.js?v=100","src/quest-image-api.js?v=100","src/quest-ui.js?v=100","styles/quest.css?v=100","styles/rich.css?v=100","src/main-app.js?v=100","src/session-engine.js?v=100","src/session-editors.js?v=100","src/data-backup.js?v=100","compact.html?v=100","styles/compact.css?v=100","src/compact-app.js?v=100","src/haptics.js?v=100","manifest.webmanifest?v=10","apple-touch-icon.png?v=10","assets/favicon-32.png?v=10","assets/icon-192.png?v=10","assets/icon-512.png?v=10","assets/delivery-scooter.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate",event=>{
  event.waitUntil((async () => {
    const revision = Number(CACHE.split("-v")[1]);
    const keys = await caches.keys();
    const obsolete = keys.filter(key => {
      const match = /^ubereats-progress-v(\d+)$/.exec(key);
      return match && Number(match[1]) < revision;
    });
    await Promise.all(obsolete.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Pages are matched without their query so "./", "./?v=10" and "index.html" all
// open offline. Other files must match their ?v= exactly; a looser match is only
// an offline fallback, so a new page never silently runs an older script.
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET"||new URL(request.url).origin!==self.location.origin)return;
  event.respondWith((async()=>{
    if(request.mode==="navigate"){
      const page=await caches.match(request,{cacheName:CACHE,ignoreSearch:true});
      if(page)return page;
      try{return await fetch(request);}
      catch(error){
        const fallback=await caches.match("index.html",{cacheName:CACHE,ignoreSearch:true});
        if(fallback)return fallback;
        throw error;
      }
    }
    const exact=await caches.match(request,{cacheName:CACHE});
    if(exact)return exact;
    try{
      const response=await fetch(request);
      if(response&&response.ok&&response.type==="basic"){
        const copy=response.clone();
        caches.open(CACHE).then(cache=>cache.put(request,copy));
      }
      return response;
    }catch(error){
      const fallback=await caches.match(request,{cacheName:CACHE,ignoreSearch:true});
      if(fallback)return fallback;
      throw error;
    }
  })());
});
