// The script injected into the live site's main world. Patches fetch and
// XMLHttpRequest so responses for the favorites API and document-detail APIs
// are forwarded to the main process for offline caching. Also mirrors any known
// auth-token localStorage keys. Shared by main.js and the e2e tests so the test
// exercises the exact code that ships.
const INTERCEPTOR_SCRIPT = `
    (function () {
      if (window.__matsneHooked) return;
      window.__matsneHooked = true;

      function isFavUrl(u) {
        // Match both the SPA route (/profile/favorites) and the data API path
        // (e.g. /rest/ldms-matsne-api/api/.../favorite...), case-insensitive.
        return typeof u === 'string' && u.toLowerCase().indexOf('favorite') !== -1;
      }
      function getQueryParam(u, name) {
        try {
          var q = String(u).split('?')[1];
          if (!q) return null;
          var re = new RegExp('(?:^|&)' + name + '=([^&#]+)');
          var m = q.match(re);
          return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
      }
      // Cache the currently-viewed document id so page/content and structure/get
      // responses (which key on publicationId) can be associated with it.
      window.__matsneCurrentDocId = null;

      function classifyDocApi(u) {
        // Returns { id, part } if the URL is a doc-detail API we want to cache.
        try {
          if (typeof u !== 'string') return null;
          if (u.indexOf('/normative/page/get') !== -1) {
            var idA = getQueryParam(u, 'id');
            if (idA) return { id: idA, part: 'pageGet' };
          }
          if (u.indexOf('/normative/page/content') !== -1 && window.__matsneCurrentDocId) {
            return { id: window.__matsneCurrentDocId, part: 'pageContent' };
          }
          if (u.indexOf('/normative/structure/get') !== -1 && window.__matsneCurrentDocId) {
            return { id: window.__matsneCurrentDocId, part: 'structureGet' };
          }
        } catch (e) {}
        return null;
      }

      var origFetch = window.fetch;
      window.fetch = function () {
        var args = arguments;
        var url = '';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; } catch (e) {}
        return origFetch.apply(this, args).then(function (res) {
          try {
            if (isFavUrl(url) && res && res.ok) {
              res.clone().json().then(function (data) {
                try { window.matsne && window.matsne.cacheFavorites && window.matsne.cacheFavorites(url, data); } catch (e) {}
              }).catch(function () {});
            }
            var docCls = classifyDocApi(url);
            if (docCls && res && res.ok) {
              // Doc parts can be JSON (page/get) or HTML (page/content). Read as
              // text and keep the parsed object, or wrap raw HTML as { html }.
              res.clone().text().then(function (text) {
                var val;
                try { val = JSON.parse(text); } catch (e) { val = { html: text }; }
                try { window.matsne && window.matsne.cacheDocPart && window.matsne.cacheDocPart({ id: docCls.id, part: docCls.part, data: val }); } catch (e) {}
              }).catch(function () {});
            }
          } catch (e) {}
          return res;
        });
      };

      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__matsneUrl = u; return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var self = this;
        this.addEventListener('load', function () {
          try {
            var u = self.__matsneUrl;
            if (isFavUrl(u) && self.status >= 200 && self.status < 300) {
              var data = null;
              try { data = JSON.parse(self.responseText); } catch (e) {}
              if (data) {
                try { window.matsne && window.matsne.cacheFavorites && window.matsne.cacheFavorites(u, data); } catch (e) {}
              }
            }
            var docCls = classifyDocApi(u);
            if (docCls && self.status >= 200 && self.status < 300) {
              var docData;
              try { docData = JSON.parse(self.responseText); } catch (e) { docData = { html: self.responseText }; }
              if (docData != null) {
                try { window.matsne && window.matsne.cacheDocPart && window.matsne.cacheDocPart({ id: docCls.id, part: docCls.part, data: docData }); } catch (e) {}
              }
            }
          } catch (e) {}
        });
        return origSend.apply(this, arguments);
      };

      function reportDocLocation() {
        try {
          if (location.pathname.indexOf('/documents/search') !== -1) {
            var id = getQueryParam(location.search, 'id');
            if (id) {
              window.__matsneCurrentDocId = id;
              try { window.matsne && window.matsne.cacheDocumentUrl && window.matsne.cacheDocumentUrl({ id: id, pageUrl: location.href }); } catch (e) {}
            }
          } else {
            window.__matsneCurrentDocId = null;
          }
        } catch (e) {}
      }
      var _push = history.pushState;
      history.pushState = function () { var r = _push.apply(history, arguments); reportDocLocation(); return r; };
      var _replace = history.replaceState;
      history.replaceState = function () { var r = _replace.apply(history, arguments); reportDocLocation(); return r; };
      window.addEventListener('popstate', reportDocLocation);
      reportDocLocation();
      setInterval(reportDocLocation, 3000);

      function pushToken() {
        try {
          var keys = ['token', 'authToken', 'access_token', 'accessToken', 'jwt', 'Authorization', 'id_token'];
          for (var i = 0; i < keys.length; i++) {
            var v = null;
            try { v = localStorage.getItem(keys[i]); } catch (e) {}
            if (v) {
              try { window.matsne && window.matsne.cacheToken && window.matsne.cacheToken(keys[i], v); } catch (e) {}
              return;
            }
          }
        } catch (e) {}
      }
      pushToken();
      setInterval(pushToken, 5000);
    })();
  `;

module.exports = { INTERCEPTOR_SCRIPT };
