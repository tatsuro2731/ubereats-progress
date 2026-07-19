const CACHE="ubereats-progress-v36";
const ASSETS=["./?v=36","index.html?v=36","app-enhancements.js?v=1","app-enhancements-fix.js?v=1","app-session-ui-fix.js?v=1","compact.html","manifest.webmanifest","apple-touch-icon.png","assets/favicon-32.png","assets/icon-192.png","assets/icon-512.png","assets/delivery-scooter.png"];

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

async function injectEnhancement(response){
  if(!response||!response.ok)return response;
  const html=await response.text();
  if(html.includes("app-session-ui-fix.js"))return new Response(html,{status:response.status,statusText:response.statusText,headers:response.headers});
  const scripts='<script src="app-enhancements.js?v=1"></script><script src="app-enhancements-fix.js?v=1"></script><script src="app-session-ui-fix.js?v=1"></script>';
  const enhanced=html.replace("</body>",scripts+"</body>");
  const headers=new Headers(response.headers);
  headers.set("content-type","text/html; charset=utf-8");
  headers.delete("content-length");
  return new Response(enhanced,{status:response.status,statusText:response.statusText,headers});
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
      if(isMainPage(event.request))return injectEnhancement(response);
      return response;
    }catch(_){
      const fallback=await caches.match("index.html",{ignoreSearch:true});
      return isMainPage(event.request)?injectEnhancement(fallback):fallback;
    }
  })());
});