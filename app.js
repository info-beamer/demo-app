'use strict'; (async () => {
const CONFIG = window.CONFIG

if ('serviceWorker' in navigator) {
  try {
    const registration = await navigator.serviceWorker.register(CONFIG.app_root + 'sw.js?v=' + CONFIG.app_version)
    console.log('ServiceWorker registration successful with scope: ', registration.scope)
  } catch (e) {
    console.log('ServiceWorker registration failed: ', e)
  }
}

function handled_popup_url_params() {
  const q = new URL(location).searchParams

  // If there's no oauth 'state' parameter, there's nothing to do.
  if (!q.has('state'))
    return false

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
    return true
  }
}

if (handled_popup_url_params())
  return

function now() {
  return Math.floor(+new Date()/1000)
}

function lsplit(val, sep, maxsplit) {
  let split = val.split(sep)
  return maxsplit ? split.slice(0, maxsplit).concat(split.slice(maxsplit).join(sep)) : split
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
      const resp = await Vue.http.post(CONFIG.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: refresh_token,
      })
      // console.log(resp)
      localStorage.setItem('access_token', resp.data.access_token)
      localStorage.setItem('access_token_expire', now() + resp.data.expires_in - 120)
      console.log("refreshed access token")
      return next_path
    } catch (e) {
      console.log(e)
      localStorage.removeItem('refresh_token')
    }
  }

  console.log("initiating new oauth flow")

  // Generate state/code_verifier for oauth flow
  const state = random()
  const code_verifier = random()
  const code_challenge = await pkce_verifier_to_challenge(code_verifier)

  // Build the authorization URL
  const url = CONFIG.authorization_endpoint 
      + "?response_type=code"
      + "&client_id="+encodeURIComponent(CONFIG.client_id)
      + "&state="+encodeURIComponent(state)
      + "&scope="+encodeURIComponent(CONFIG.requested_scopes)
      + "&redirect_uri="+encodeURIComponent(CONFIG.redirect_uri)
      + "&code_challenge="+encodeURIComponent(code_challenge)
      + "&code_challenge_method=S256"

  const wait_for_auth_complete = new Promise((resolve, reject) => {
    window.addEventListener('message', e => {
      resolve(e.data)
    })
  })

  // Redirect to the authorization server...
  const auth_popup = window.open(url, '_blank')
  if (!auth_popup) {
    app.$f7.dialog.alert('Cannot start authentication')
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
      const resp = await Vue.http.post(CONFIG.token_endpoint, {
        grant_type: "authorization_code",
        code: redirect.code,
        client_id: CONFIG.client_id,
        redirect_uri: CONFIG.redirect_uri,
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

async function fetch_account() {
  if (!is_logged_in())
    return false
  try {
    store.dispatch('update_account')
    return true
  } catch (e) {
    return false
  }
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
      // return true
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
    set_device(state, info) {
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

Vue.component('busy-indicator', {
  template: `
    <f7-progressbar infinite :style='style'/>
  `,
  computed: {
    style() {
      return {
        visibility: this.$store.getters.is_busy ? 'visible': 'hidden'
      }
    }
  }
})

Vue.component('full-page', {
  template: `
    <f7-page>
      <f7-navbar large transparent/>
      <slot/>
    </f7-page>
  `,
  props: ['title', 'back'],
})

Vue.component('main-page', {
  template: `
    <f7-page
      :ptr='!!$listeners.refresh' :ptr-mousewheel="true"
      @ptr:refresh="refresh"
    >
      <f7-navbar>
        <f7-nav-left>
          <f7-link panel-open="left" icon-ios="f7:menu" icon-aurora="f7:menu" icon-md="material:menu"/>
        </f7-nav-left>
        <f7-nav-title>{{title}}</f7-nav-title>
        <slot name='navbar'/>
      </f7-navbar>
      <busy-indicator/>
      <slot/>
    </f7-page>
  `,
  props: ['title'],
  methods: {
    refresh(done) {
      this.$emit('refresh')
      done()
    }
  }
})

Vue.component('tab-page', {
  template: `
    <f7-page
      :ptr='!!$listeners.refresh' :ptr-mousewheel="true"
      @ptr:refresh="refresh"
    >
      <f7-navbar>
        <f7-nav-left>
          <f7-link panel-open="left" icon-ios="f7:menu" icon-aurora="f7:menu" icon-md="material:menu"/>
        </f7-nav-left>
        <f7-nav-title>{{title}}</f7-nav-title>
      </f7-navbar>
      <f7-toolbar bottom tabbar>
        <slot name='tabbar'/>
      </f7-toolbar>
      <f7-tabs routable>
        <slot name='tabs'/>
      </f7-tabs>
    </f7-page>
  `,
  props: ['title'],
  methods: {
    refresh(done) {
      this.$emit('refresh')
      done()
    }
  }
})

Vue.component('tab-slot', {
  template: `
    <div>
      <busy-indicator/>
      <f7-block-title>{{title}}</f7-block-title>
      <slot/>
    </div>
  `,
  props: ['title'],
})

Vue.component('detail-page', {
  template: `
    <f7-page
      :ptr='!!$listeners.refresh' :ptr-mousewheel="true"
      @ptr:refresh="refresh"
    >
      <busy-indicator/>
      <f7-navbar :title="title" :back-link='back || "Back"'/>
      <slot/>
    </f7-page>
  `,
  props: ['title', 'back'],
  methods: {
    refresh(done) {
      this.$emit('refresh')
      done()
    }
  }
})

//------------------------------------------

const Dashboard = Vue.component('dashboard-view', {
  template: `
    <main-page title='Dashboard' @refresh='update'>
      <template v-if='account'>
        <f7-block>
          <b>{{account.email}}</b>
        </f7-block>
        <f7-block>
          Balance<br/>
          <b>{{account.balance}}</b>
        </f7-block>
        <f7-block>
          Billed devices<br/>
          <b>{{account.usage.devices}}</b>
        </f7-block>
        <f7-block>
          Storage used<br/>
          <b>{{account.usage.storage|format_size}}</b>
        </f7-block>
      </template>
    </main-page>
  `,
  created() {
  },
  created() {
    this.update()
  },
  computed: {
    account() {
      return this.$store.state.account_info
    }
  },
  methods: {
    async update() {
      await this.$store.dispatch('update_account')
    }
  }
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
    <detail-page
      :title='device && device.description || "Unnamed Device"'
      @refresh='update'
    >
      <template v-if='device'>
        <div class='snap' :style='snap_style'/>
        <br/>
        <div class='snapshot' :style='snap_style'/>
        <f7-list>
          <f7-list-item header='Status' :title='status'/>
          <f7-list-item header='Display resolution' :title='run.resolution' v-if='run.resolution'/>
          <f7-list-item header='Assigned Setup' :title='device.setup ? device.setup.name : "No setup assigned"'/>
          <f7-list-item header='Hardware model' v-if='hw' :title='hw.model'/>
          <f7-list-item header='Device serial' :title='device.serial'/>
          <f7-list-item header='OS release' :title='run.tag' v-if='run.tag'/>
          <f7-list-item header='Last reboot' :title='restarted_ago | format_ago' v-if='restarted_ago'/>
          <f7-list-item header='Last seen' :title='device.last_seen_ago | format_ago' v-if='device.last_seen_ago != null'/>
        </f7-list>
      </template>
    </detail-page>
  `,
  props: ['device_id'],
  data: () => ({
    device: null,
    snap: null,
  }),
  created() {
    this.update()
  },
  computed: {
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
    async update() {
      await Promise.all([
        this.update_snap(),
        this.update_info(),
      ])
    },
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
  }
})

const DeviceList = Vue.component('device-list', {
  template: `
    <tab-slot :title='mode_settings.title'>
      <f7-block strong v-if='device_groups.length == 0 && !$store.getters.is_busy'>
        <p>
          No devices match your query
        </p>
      </f7-block>
      <f7-list>
        <template v-for='group in device_groups'>
          <f7-list-item :group-title='true' :title='group.group' v-if='group.group'/>
          <f7-list-item
            :key='device.id' v-for='device in group.devices'
            :badge='device.online_status'
            :badge-color='device.online_status_color'
            :link='"/device/" + device.id' :header='device.location'
            :title='device.description'
          />
        </template>
      </f7-list>
    </tab-slot>
  `,
  props: ['mode'],
  data: () => ({
    modes: {
      all: {
        title: 'All devices',
        filter: d => true,
        groups: d => {
          d.sort((a, b) => {
            a = a.description.toLocaleLowerCase()
            b = b.description.toLocaleLowerCase()
            return a.localeCompare(b)
          })
          let groups = {}
          for (const device of d) {
            if (!groups[device.group]) 
              groups[device.group] = []
            groups[device.group].push(device)
          }
          let group_list = []
          for (const group in groups) {
            group_list.push({group: group, devices: groups[group]})
          }
          group_list.sort((a, b) => {
            a = a.group.toLocaleLowerCase()
            b = b.group.toLocaleLowerCase()
            return a.localeCompare(b)
          })
          return group_list
        }
      },
      online: {
        title: 'Online only',
        filter: d => d.is_online,
        groups: d => {
          d.sort((a, b) => {
            a = a.description.toLocaleLowerCase()
            b = b.description.toLocaleLowerCase()
            return a.localeCompare(b)
          })
          return [{group: '', devices: d}]
        }
      },
      offline: {
        title: 'Recently gone offline',
        filter: d => !d.is_online && d.last_seen_ago != null,
        groups: d => {
          d.sort((a, b) => {
            return a.last_seen_ago - b.last_seen_ago
          })
          return [{group: '', devices: d}]
        }
      }
    }
  }),
  computed: {
    mode_settings() {
      return this.modes[this.mode]
    },
    device_groups() {
      const now = Math.floor(+ new Date() / 1000)
      const devices = []
      for (const device of this.$store.state.device_infos) {
        if (!this.mode_settings.filter(device))
          continue

        let [group_name, name] = lsplit(device.description, "/", 1)
        if (name.length == 0) {
          name = group_name
          group_name = "Ungrouped"
        }

        let online_status
        if (device.last_seen_ago == null) {
          online_status = "unknown"
        } else if (device.is_online) {
          online_status = "online"
        } else {
          const offline_days = device.last_seen_ago / 86400
          if (offline_days < device.offline.max_offline) {
            online_status = "disconnected"
          } else {
            online_status = "offline"
          }
        }

        let chargeable = false
        let disabled = device.last_seen_ago == null
        if (device.last_seen_ago != null) {
          const offline_days = device.last_seen_ago / 86400
          chargeable = offline_days < device.offline.chargeable
          disabled = offline_days > device.offline.max_offline
        }

        devices.push({
          id: device.id,
          serial: device.serial,
          name: name,
          group: group_name,
          description: device.description,
          location: device.location,
          is_online: device.is_online,
          is_synced: device.is_synced,
          run: device.run,
          hw: device.hw,
          geo: device.geo,
          model: device.hw && device.hw.model || 'Unknown model',
          last_seen_ago: device.last_seen_ago,
          setup_id: device.setup ? device.setup.id : null,
          setup_name: device.setup ? device.setup.name : null,
          uptime: device.is_online ? now - device.run.restarted : null,
          needs_maintenance: device.maintenance.length > 0,
          licensed: device.offline.licensed,
          online_status: online_status,
          online_status_color: {
            offline: 'deeporange',
            online: 'green',
            disconnected: 'orange',
            unknown: 'gray',
          }[online_status],
          chargeable: chargeable,
          disabled: disabled,
          offline_plan: device.offline.plan,
        })
      }

      return this.mode_settings.groups(devices)
    },
  },
})

const DeviceListSelect = Vue.component('device-list-select', {
  template: `
    <tab-page title='Devices' @refresh='update'>
      <template slot='tabbar'>
        <f7-link tab-link href="/devices/" route-tab-id="all">All</f7-link>
        <f7-link tab-link href="/devices/online" route-tab-id="online">Online</f7-link>
        <f7-link tab-link href="/devices/offline" route-tab-id="offline">Offline</f7-link>
      </template>
      <template slot='tabs'>
        <f7-tab class="page-content" id='all'>
          <device-list mode='all'/>
        </f7-tab>
        <f7-tab class="page-content" id="online">
          <device-list mode='online'/>
        </f7-tab>
        <f7-tab class="page-content" id="offline">
          <device-list mode='offline'/>
        </f7-tab>
      </template>
    </tab-page>
  `,
  created() {
    this.update()
  },
  methods: {
    update() {
      this.$store.dispatch('update_devices')
    },
  }
})

const About = Vue.component('index-view', {
  template: `
    <detail-page title='About'>
      <f7-block-title medium>Welcome to info-beamer</f7-block-title>
      <f7-block strong>
        <p>
          This demo app shows how an app interacting with your
          info-beamer hosted account might look like.
        </p>
      </f7-block>
    </detail-page>
  `,
})

const Index = Vue.component('index-view', {
  template: `
    <full-page class='index-page color-theme-black'>
      <div class='text-align-center'>
        <img class='logo' src='icon-192.png'>
      </div>
      <f7-block>
        <f7-button large strong outline @click="login">
          Access account
        </f7-button>
      </f7-block>
      <f7-block-footer>
        Login requires an existing info-beamer account.
      </f7-block-footer>
    </full-page>
  `,
  async created() {
    if (await fetch_account()) {
      console.log("already logged in")
      // this.$f7router.navigate("/dashboard")
    }
  },
  methods: {
    async login() {
      this.$f7.dialog.preloader('Log in...')
      const next_url = await auth_login_then("/dashboard")
      this.$f7.dialog.close()
      this.$f7router.navigate(next_url, {
        clearPreviousHistory: true,
        transition: 'f7-flip',
      })
    },
  }
})

//------------------------------------------

Vue.component('nav-menu', {
  template: `
    <f7-page>
      <f7-block text-align-center>
        <img class='logo' src='icon-192.png'>
      </f7-block>
      <f7-block-title strong>info-beamer demo app</f7-block-title>
      <f7-list>
        <f7-list-item link="/dashboard" title="Dashboard" panel-close/>
        <f7-list-item link="/devices/" title="Devices" panel-close/>
        <f7-list-item link="/about" title="About" panel-close/>
        <f7-list-item :footer='account.email' @click='logout' title="Logout" panel-close v-if='account'/>
      </f7-list>
      <f7-block-footer>version {{version}}</f7-block-footer>
    </f7-page>
  `,
  data: () => ({
    version: CONFIG.app_version,
  }),
  computed: {
    account() {
      return this.$store.state.account_info
    }
  },
  methods: {
    async logout() {
      await auth_logout()
      window.location.href = CONFIG.app_root
    },
  }
})

function require_login(to, from, resolve, reject) {
  if (is_logged_in()) {
    resolve(to.url)
  } else {
    reject()
    // TODO: meh. couldn't find a better way :-(
    window.location.href = CONFIG.app_root
  }
}

const ROUTES = [{
  path: '/',
  component: Index,
}, {
  path: '/about',
  component: About, 
}, {
  path: '/dashboard',
  component: Dashboard, 
  beforeEnter: require_login,
}, {
  path: '/devices',
  component: DeviceListSelect,
  beforeEnter: require_login,
  tabs: [{
    path: "/",
    id: 'all'
  }, {
    path: "/online",
    id: 'online'
  }, {
    path: "/offline",
    id: 'offline'
  }]
}, {
  path: '/device/:device_id',
  component: DeviceDetail,
  beforeEnter: require_login,
}]

Vue.component('app-view', {
  template: `
    <f7-app :params='f7params' class='color-theme-orange'>
      <f7-panel left cover reveal>
        <f7-view links-view=".view-main">
          <nav-menu/>
        </f7-view>
      </f7-panel>
      <f7-view main :push-state="true" push-state-separator="#" url="/"/>
    </f7-app>
  `,
  data: () => ({
    f7params: {
      name: window.document.title,
      id: 'com.infobeamer.app',
      routes: ROUTES,
    }
  })
})

//------------------------------------------

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

// Configure vue-resource for the info-beamer API
Vue.http.options.root = window.CONFIG.api_root
Vue.http.interceptors.push(request => {
  store.commit('update_busy', +1)
  const access_token = localStorage.getItem('access_token')
  request.headers.set('Authorization', 'Bearer ' + access_token)
  return response => {
    store.commit('update_busy', -1)
    if (response.status == 401 && request.url != 'account/session/destroy') {
      localStorage.removeItem('access_token')
      // app.$f7.dialog.alert('Permission denied. Try reloading the page')
      window.location.href = CONFIG.app_root
    }
  }
})

Framework7.use(Framework7Vue)

// Render the app
const app = new Vue({el: '#app', store})
window.app = app

})()
