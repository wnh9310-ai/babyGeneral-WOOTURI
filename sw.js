const CACHE = 'wuturi-shell-v27';
const SHELL = ['./','./index.html','./styles.css?v=15','./app.mjs?v=23','./archive.mjs?v=2','./route-map.mjs','./data.mjs?v=2','./parsers.mjs?v=3','./analytics.mjs','./manifest.webmanifest','./icon.svg','./brand/wooturi-mark.png','./brand/wooturi-small.svg','./vendor/leaflet/leaflet.js','./vendor/leaflet/leaflet.css'];
self.addEventListener('install',(event)=>event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',(event)=>event.waitUntil(caches.keys().then((keys)=>Promise.all(keys.filter((key)=>key!==CACHE).map((key)=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',(event)=>{
  const request=event.request;
  if(request.method!=='GET'||new URL(request.url).origin!==self.location.origin)return;
  if(request.mode==='navigate'){event.respondWith(fetch(request).catch(()=>caches.match('./index.html')));return;}
  event.respondWith(caches.match(request).then((cached)=>cached||fetch(request).then((response)=>{
    if(response.ok) caches.open(CACHE).then((cache)=>cache.put(request,response.clone()));
    return response;
  })));
});
