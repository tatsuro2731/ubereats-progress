const CACHE="ubereats-progress-v32";
const ASSETS=["./?v=32","index.html?v=32","compact.html","manifest.webmanifest","apple-touch-icon.png","assets/favicon-32.png","assets/icon-192.png","assets/icon-512.png","assets/delivery-scooter.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{if(res&&res.ok&&res.type==="basic"){let cp=res.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}return res}).catch(()=>caches.match("index.html",{ignoreSearch:true}))))});
