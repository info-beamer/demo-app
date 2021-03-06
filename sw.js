const CACHE_NAME = 'hosted-app-v1'
const APP_ROOT = '/'

async function cacheResources(version) {
  const cache = await caches.open(CACHE_NAME)
  return cache.addAll([
    APP_ROOT + 'app.js?v=' + version,
    APP_ROOT + 'app.css?v=' + version,
    APP_ROOT + 'sw.js?v=' + version,
    APP_ROOT + 'vue.js',
    APP_ROOT + 'vuex.js',

    APP_ROOT + 'vue-resource.js',
    APP_ROOT + 'framework7.bundle.min.js',
    APP_ROOT + 'framework7-vue.bundle.min.js',

    APP_ROOT + 'material-icons.css',
    APP_ROOT + 'framework7-icons.css',
    APP_ROOT + 'framework7.bundle.min.css',
    APP_ROOT + 'fonts/Framework7Icons-Regular.woff2',
    APP_ROOT + 'fonts/MaterialIcons-Regular.woff2',

    APP_ROOT + 'favicon.png',
    APP_ROOT + 'icon-192.png',
    APP_ROOT + 'icon-512.png',
    APP_ROOT + 'manifest.json',
  ])
}

self.addEventListener('install', event => {
  const version = new URL(location).searchParams.get('v')
  console.log('service worker version', version)
  event.waitUntil(cacheResources(version))
})

async function cachedResource(request) {
  const cache = await caches.open(CACHE_NAME)
  return await cache.match(request)
}

async function handleRequest(request) {
  let response = await cachedResource(request)
  if (!response) {
    response = await fetch(request)
  }
  return response
}

self.addEventListener('fetch', event => 
  event.respondWith(handleRequest(event.request))
)
