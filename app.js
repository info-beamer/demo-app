'use strict'; (async () => {
const config = window.CONFIG

if ('serviceWorker' in navigator) {
  try {
    const registration = await navigator.serviceWorker.register(config.app_root + 'sw.js?v=' + config.app_version)
    console.log('ServiceWorker registration successful with scope: ', registration.scope)
  } catch (e) {
    console.log('ServiceWorker registration failed: ', e)
  }
}

function handle_url_params() {
  const q = new URL(location).searchParams

  // If there's no oauth 'state' parameter, there's nothing to do.
  if (!q.has('state'))
    return

  if (!window.opener) {
    alert("no opener. uh oh")
  } else {
    try {
      window.opener.postMessage({
        error: q.get('error'),
        error_description: q.get('error_description'),
        code: q.get('code'),
        state: q.get('state'),
      }, location.origin)
    } catch (e) {
      alert(e)
    }
    window.close()
  }
}

handle_url_params()

function now() {
  return Math.floor(+new Date()/1000)
}

function random() {
  const array = new Uint32Array(16)
  window.crypto.getRandomValues(array)
  return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('')
}

function sha256(plain) {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return window.crypto.subtle.digest('SHA-256', data)
}

function base64_pkce(str) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function pkce_verifier_to_challenge(v) {
  const hashed = await sha256(v)
  return base64_pkce(hashed)
}

function is_logged_in() {
  return !!localStorage.getItem('access_token')
}

async function auth_logout() {
  console.log("wiping authentication state")
  try {
    // kill the session. This invalidates the access_token
    // used to call this endpoint.
    await Vue.http.post('account/session/destroy')
  } catch (e) {
    console.log(e)
  }
  localStorage.removeItem('access_token')
  localStorage.removeItem('access_token_expire')
  localStorage.removeItem('refresh_token')
  window.location.href = config.app_root
}

async function auth_login_then(next_path) {
  const access_token = localStorage.getItem('access_token')
  const expires_at = parseInt(localStorage.getItem('access_token_expire') || 0)
  if (access_token && now() < expires_at)
    return next_path

  // try refresh token
  const refresh_token = localStorage.getItem('refresh_token')
  if (refresh_token) {
    try {
      const resp = await Vue.http.post(config.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: refresh_token,
      })
      console.log(resp)
      localStorage.setItem('access_token', resp.data.access_token)
      localStorage.setItem('access_token_expire', now() + resp.data.expires_in - 120)
      console.log("refreshed access token")
      return next_path
    } catch (e) {
      console.log(e)
      auth_logout()
      return '/'
    }
  }

  console.log("initiating new oauth flow")

  // Generate state/code_verifier for oauth flow
  const state = random()
  const code_verifier = random()
  const code_challenge = await pkce_verifier_to_challenge(code_verifier)

  // Build the authorization URL
  const url = config.authorization_endpoint 
      + "?response_type=code"
      + "&client_id="+encodeURIComponent(config.client_id)
      + "&state="+encodeURIComponent(state)
      + "&scope="+encodeURIComponent(config.requested_scopes)
      + "&redirect_uri="+encodeURIComponent(config.redirect_uri)
      + "&code_challenge="+encodeURIComponent(code_challenge)
      + "&code_challenge_method=S256"

  const wait_for_auth_complete = new Promise((resolve, reject) => {
    window.addEventListener('message', e => {
      resolve(e.data)
    })
  })

  // Redirect to the authorization server...
  const auth_popup = window.open(url, 'Grant authorization to app')
  if (!auth_popup) {
    alert("Cannot start authentication")
    return '/'
  }

  // ..and wait for it to return in the opened popup..
  const redirect = await wait_for_auth_complete
  console.log('received redirect state', redirect)

  // ..and close it
  try {
    auth_popup.close()
  } catch (e) {
    alert(e)
  }

  if (redirect.state != state) {
    // If the state doesn't match the locally saved state,
    // we have to abort the flow. Someone might have started
    // it without our knowledge.
    alert("Invalid state")
    return '/'
  } 
  
  if (redirect.error) {
    // If there's an error response, print it out
    alert(redirect.error_description)
    return '/'
  }
  
  if (redirect.code) {
    // Exchange the authorization code for an access token
    try {
      const resp = await Vue.http.post(config.token_endpoint, {
        grant_type: "authorization_code",
        code: redirect.code,
        client_id: config.client_id,
        redirect_uri: config.redirect_uri,
        code_verifier: code_verifier,
      })

      // Save retrieved access_token. The app can start init it with.
      localStorage.setItem('access_token', resp.data.access_token)
      localStorage.setItem('access_token_expire', now() + resp.data.expires_in - 120)
      localStorage.setItem('refresh_token', resp.data.refresh_token)
    } catch (e) {
      alert("Cannot exchange token")
      return '/'
    }
  }

  return next_path
}

const store = new Vuex.Store({
  strict: true,
  state: {
    busy: 0,
    account_info: null,
    device_infos: [],
  },
  getters: {
    is_busy(state) {
      return state.busy > 0
    },
  },
  mutations: {
    set_account(state, info) {
      state.account_info = info
    },
    set_devices(state, info) {
      state.device_infos = info
    },
    update_busy(state, delta) {
      state.busy += delta
    },
    ready(state) {
      state.ready = true
    },
  },
  actions: {
    async init({commit, state}) {
      commit('init')
      commit('ready')
    },
    async update_account({commit, state}) {
      const resp = await Vue.http.get('account')
      commit('set_account', resp.data)
    },
    async update_devices({commit, state}) {
      const resp = await Vue.http.get('device/list')
      commit('set_devices', resp.data.devices)
    },
  }
})

Vue.component('account-page', {
  template: `
    <div>
      <div class='busy' :class='{is_busy: $store.getters.is_busy}'>
        <svg v-if='$store.getters.is_busy' xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="5px" preserveAspectRatio="xMidYMid">
          <defs>
            <pattern id="foo" x="0" y="0" width="76.80000000000001" height="76.80000000000001" patternUnits="userSpaceOnUse">
            <g transform="scale(0.30000000000000004)">
            <defs>
              <g id="bar">
                <path d="M256 -128 L384 -128 L-128 384 L-128 256 Z" fill="#5d5d5d"></path>
                <path d="M384 0 L384 128 L128 384 L0 384 Z" fill="#5d5d5d"></path>
              </g>
            </defs>
            <g transform="translate(179.563 0)">
              <use xlink:href="#bar" x="-256" y="0"></use><use xlink:href="#bar" x="0" y="0"></use>
              <animateTransform attributeName="transform" type="translate" keyTimes="0;1" repeatCount="indefinite" dur="0.8s" values="0 0; 256 0"></animateTransform>
            </g></g>
            </pattern>
          </defs>
          <rect x="0" y="0" width="100%" height="10px" fill="url(#foo)"></rect>
        </svg>
      </div>
      <div class='container-fluid'>
        <div class='row nav-top'>
          <router-link tag='div' class='dashboard col col-xs-4' to='/dashboard'>
            &nbsp;
          </router-link>
          <router-link tag='div' class='col col-xs-4' to='/device'>
            Devices
          </router-link>
          <div class='col-xs-4' @click='logout'>
            Logout
          </div>
        </div>
        <slot/>
      </div>
    </div>
  `,
  methods: {
    async logout() {
      await auth_logout()
    }
  }
})

Vue.component('bottom-buttons', {
  template: `
    <div class='nav-bottom'>
      <div class='row'>
        <slot/>
      </div>
    </div>
  `
})

const Dashboard = Vue.component('dashboard-view', {
  template: `
    <account-page>
      <template v-if='account'>
        <div class='alert alert-danger text-center' v-if='!account.devices_active'>
          Insufficient funds. Devices disabled!
        </div>
        <h3 class='text-center dashboard-item'>
          <b>{{account.email}}</b>
        </h3>
        <h3 class='text-center dashboard-item'>
          Balance<br/>
          <b>{{account.balance}}</b>
        </h3>
        <h3 class='text-center dashboard-item'>
          Billed devices<br/>
          <b>{{account.usage.devices}}</b>
        </h3>
        <h3 class='text-center dashboard-item'>
          Storage used<br/>
          <b>{{account.usage.storage|format_size}}</b>
        </h3>
      </template>
    </account-page>
  `,
  created() {
    this.$store.dispatch('update_account')
  },
  computed: {
    account() {
      return this.$store.state.account_info
    }
  },
})

function device_status(device) {
  if (device.last_seen_ago == null) {
    return "unknown"
  } else if (device.is_online) {
    return "online"
  } else {
    const offline_days = device.last_seen_ago / 86400
    if (offline_days < device.offline.max_offline) {
      return "disconnected"
    } else {
      return "offline"
    }
  }
}

const DeviceDetail = Vue.component('devices-detail', {
  template: `
    <account-page>
      <div v-if='device' class='device-detail'>
        <h3>
          {{device.description || '&lt;unnamed device&gt;'}}
        </h3>
        <div class='snap' :style='snap_style'/>
        <br/>
        <table class='table table-condensed'>
          <thead>
            <tr>
              <th>Property</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if='hw'>
              <td>Status</td>
              <td>{{status}}</td>
            </tr>
            <tr v-if='run.resolution'>
              <td>Resolution</td>
              <td>{{run.resolution}}</td>
            </tr>
            <tr>
              <td>Setup</td>
              <td>
                <template v-if='device.setup'>
                  {{device.setup.name}}
                </template>
                <template v-else>
                  <em>No setup assigned</em>
                </template>
              </td>
            </tr>
            <tr v-if='hw'>
              <td>Model</td>
              <td>{{hw.model}}</td>
            </tr>
            <tr>
              <td>Serial</td>
              <td>{{device.serial}}</td>
            </tr>
            <tr v-if='run.tag'>
              <td>OS Release</td>
              <td>{{run.tag}}</td>
            </tr>
            <tr v-if='restarted_ago'>
              <td>Last reboot</td>
              <td>{{restarted_ago | format_ago}}</td>
            </tr>
            <tr v-if='device.last_seen_ago != null'>
              <td>Last seen</td>
              <td>{{device.last_seen_ago | format_ago}}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <bottom-buttons>
        <router-link tag='div' class='col-xs-3 col-xs-offset-6 item' to='/device'>
          Back
        </router-link>
        <div class='col-xs-3 item' @click='update'>
          Refresh
        </div>
      </bottom-buttons>
    </account-page>
  `,
  data: () => ({
    device: null,
    snap: null,
  }),
  created() {
    this.update()
  },
  computed: {
    device_id() {
      return this.$route.params.id
    },
    hw() {
      return this.device.hw
    },
    run() {
      return this.device.run
    },
    status() {
      return device_status(this.device)
    },
    restarted_ago() {
      return this.run && (now() - this.run.restarted)
    },
    snap_style() {
      if (!this.snap) {
        return {
          backgroundColor: '#ccc',
        }
      }
      return {
        backgroundImage: `URL(${this.snap.src})`,
      }
    },
  },
  methods: {
    async update_info() {
      const info = await Vue.http.get(`device/${this.device_id}`)
      this.device = info.data
    },
    async update_snap() {
      try {
        const snap = await Vue.http.get(`device/${this.device_id}/output`)
        this.snap = snap.data
      } catch (e) {
        console.log("cannot request snapshot")
      }
    },
    async update() {
      await Promise.all([
        this.update_snap(),
        this.update_info(),
      ])
    },
  }
})

Vue.component('device-box', {
  template: `
    <router-link tag='div' :to="{name: 'device-detail', params:{id: device.id}}" class='device-box' :class='device_class'>
      <div>
        <b>{{device.description || '&lt;unnamed device&gt;'}}</b>
        /
        {{device.serial}}
      </div>
      <div>
        {{device.location || '&lt;unspecified location&gt;'}}
      </div>
      <div class='model' v-if='device.hw'>
        {{device.hw.model}}
      </div>
      <div v-if='device.last_seen_ago != null'>
        Last seen {{device.last_seen_ago | format_ago}}
      </div>
    </router-link>
  `,
  props: ['device'],
  computed: {
    device_class() {
      return device_status(this.device)
    }
  }
})

const Devices = Vue.component('devices-view', {
  template: `
    <account-page>
      <device-box :key='device.id' :device='device' v-for='device in devices'/>
      <div class='alert alert-info' v-if='devices.length == 0'>
        No devices matching your query
      </div>
      <bottom-buttons>
        <div class='col-xs-3 item' :class='{selected: selected_mode_idx==0}' @click='set_mode(0)'>
          All
        </div>
        <div class='col-xs-3 item' :class='{selected: selected_mode_idx==1}' @click='set_mode(1)'>
          Online
        </div>
        <div class='col-xs-3 item' :class='{selected: selected_mode_idx==2}' @click='set_mode(2)'>
          Offline
        </div>
        <div class='col-xs-3 item' @click='update'>
          Refresh
        </div>
      </bottom-buttons>
    </account-page>
  `,
  data: () => ({
    modes: [{
      title: 'All devices',
      filter: d => true,
      sort: (a, b) => {
        a = a.description.toLocaleLowerCase()
        b = b.description.toLocaleLowerCase()
        return a.localeCompare(b)
      }
    }, {
      title: 'Online only',
      filter: d => d.is_online,
      sort: (a, b) => {
        a = a.description.toLocaleLowerCase()
        b = b.description.toLocaleLowerCase()
        return a.localeCompare(b)
      }
    }, {
      title: 'Recently gone offline',
      filter: d => !d.is_online && d.last_seen_ago != null,
      sort: (a, b) => {
        return a.last_seen_ago - b.last_seen_ago
      }
    }],
    selected_mode_idx: 0,
  }),
  created() {
    this.update()
    const idx = localStorage.getItem('device:view:mode')
    if (idx != null) {
      this.selected_mode_idx = parseInt(idx) % this.modes.length
    }
  },
  watch: {
    selected_mode_idx: v => {
      localStorage.setItem('device:view:mode', v)
    }
  },
  computed: {
    mode() {
      return this.modes[this.selected_mode_idx]
    },
    devices() {
      const out = []
      const devices = this.$store.state.device_infos
      for (const device of devices) {
        if (this.mode.filter(device))
          out.push(device)
      }
      out.sort(this.mode.sort)
      return out
    },
  },
  methods: {
    update() {
      this.$store.dispatch('update_devices')
    },
    set_mode(idx) {
      this.selected_mode_idx = idx
    },
    switch_mode() {
      console.log(this.selected_mode_idx)
      this.selected_mode_idx = ++this.selected_mode_idx % this.modes.length
    }
  }
})

const Index = Vue.component('index-view', {
  template: `
    <div class='fullscreen'>
      <div class='inner index'>
        <img src='icon-192.png'>
        <br/><br/>
        <button class='btn btn-default btn-lg' @click='login'>
          Log in to your account
        </button>
        <div class='version'>version {{version}}</div>
      </div>
    </div>
  `,
  data: () => ({
    version: config.app_version,
  }),
  created() {
    if (is_logged_in()) {
      console.log("already logged in")
      router.push({path: '/dashboard'})
    }
  },
  methods: {
    async login() {
      router.push({path: await auth_login_then('/dashboard')})
    }
  },
})

Vue.filter('format_size', size => {
  if (size > 1024*1024*1024) {
    return (size/1024/1024/1024).toFixed(2) + 'GB'
  } else if (size > 1024*1024) {
    return (size/1024/1024).toFixed(1) + 'MB'
  } else if (size > 1024) {
    return (size/1024).toFixed(1) + 'KB'
  } else {
    return size + ' byte'
  }
})

Vue.filter('format_ago', delta => {
  function fmt(val, unit) {
    if (val == 0) {
      return ""
    } else {
      return val + " " + unit + (val > 1 ? "s" : "")
    }
  }
  if (delta < 60) {
    return 'a few moments ago'
  } else if (delta < 3600) {
    return fmt(Math.floor(delta / 60), 'minute') +' ago'
  } else if (delta < 86400) {
    return fmt(Math.floor(delta / 3600), 'hour') + ' ago'
  } else {
    return fmt(Math.floor(delta / 86400), 'day') + ' ago'
  }
})

// All info-beamer endpoints expect x-www-form-urlencoded
Vue.http.options.emulateJSON = true

// Set up router first. That way the authorization return
// can push the target path on successful authorization.
const router = new VueRouter({
  base: config.app_root,
  routes: [
    {path: '/', component: Index, meta: { no_auth: true }},
    {path: '/device', component: Devices},
    {path: '/device/:id', name: 'device-detail', component: DeviceDetail},
    {path: '/dashboard', component: Dashboard },
  ]
})

// Now set up the rest of the app
router.beforeEach(async (to, from, next) => {
  // Is the url needs authorization and we don't have an API key,
  // redirect to get one.
  if (!to.matched.some(record => record.meta.no_auth) && !is_logged_in()) {
    const new_path = await auth_login_then(to.path)
    if (new_path != to.path)
      return next(new_path)
  }

  next()
})

// Configure vue-resource for the info-beamer API
Vue.http.options.root = window.CONFIG.api_root
Vue.http.interceptors.push(request => {
  store.commit('update_busy', +1)
  const access_token = localStorage.getItem('access_token')
  request.headers.set('Authorization', 'Bearer ' + access_token)
  return response => {
    store.commit('update_busy', -1)
    if (response.status == 401 && request.url != 'account/session/destroy') {
      alert("Permission denied. Try reloading the page")
      localStorage.removeItem('access_token')
    }
  }
})

// Render the app
new Vue({el: '#app', store, router})

})()
