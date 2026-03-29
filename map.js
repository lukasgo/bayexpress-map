/* ═══════════════════════════════════════════════════════════════
   Bayexpress Interactive Sailing Map
   Phase 1: Ghost API · Dynamic categories · Search
            Clustering · Geolocation + range ring
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────
  var config = window.BAYEXPRESS_MAP || {};
  if (!config.token) return console.error('[BayExpress] No Mapbox token.');
  if (!config.ghostUrl || !config.ghostKey) return console.error('[BayExpress] No Ghost URL or API key.');

  mapboxgl.accessToken = config.token;

  var GHOST_URL = config.ghostUrl.replace(/\/$/, '');
  var GHOST_KEY = config.ghostKey;
  var BASE_URL  = (config.baseUrl || '').replace(/\/$/, '');
  var CENTER    = config.center || [28.3, 36.85];
  var ZOOM      = config.zoom || 8;
  var REGION_RE = config.regionPattern || /region$/i;
  var USER_COLORS = config.categoryColors || {};

  // Palette for auto-assigning category colors
  var COLOR_POOL = [
    '#c8a860', '#3678c0', '#2a8f6a', '#d07830',
    '#8866aa', '#c45c72', '#5a9e6f', '#b07040',
    '#6088b0', '#a0784c'
  ];
  var colorIndex = 0;

  // ── State ───────────────────────────────────────────────────
  var allPlaces    = [];   // processed places from Ghost
  var categories   = {};   // { tagName: { slug, color, count } }
  var activeFilter = 'all';
  var clusterIndex = null;  // Supercluster instance
  var mapMarkers   = [];    // currently rendered Mapbox markers
  var gpsMarker    = null;
  var gpsPosition  = null;
  var radiusCircle = null;  // GeoJSON source ID for range ring
  var radiusNm     = 5;
  var draw         = null;
  var measureActive = false;

  var STYLE_STREETS   = 'mapbox://styles/bayexpress/cj4fpg6iu1jgq2rqmr0tbxukc';
  var STYLE_SATELLITE = 'mapbox://styles/mapbox/satellite-streets-v12';
  var currentStyle    = 'streets';


  // ══════════════════════════════════════════════════════════════
  // COORDINATE PARSER
  // Handles all formats found in BayExpress Ghost posts:
  //   1. Degrees + decimal minutes:  36º 11.81´ N - 29º 50.82´ E
  //   2. Degrees + minutes + seconds: 36°44'54'' N, 28°56'34'' E
  //   3. Decimal degrees:             36.1968 N, 29.8470 E
  // Source: codeinjection_head only
  // ══════════════════════════════════════════════════════════════

  function parseCoordinates(text) {
    if (!text) return null;
    // Strip HTML if present
    text = text.replace(/<[^>]+>/g, ' ').trim();

    // Format 1: Degrees + decimal minutes — 36º 11.81´ N - 29º 50.82´ E
    var dm = text.match(
      /(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['''′´`]+\s*([NSns])\s*[–—\-,;\/\s]+\s*(\d{1,3})\s*[°º]\s*(\d{1,2}(?:[.,]\d+)?)\s*['''′´`]+\s*([EWew])/
    );
    if (dm) {
      var lat = +dm[1] + parseFloat(dm[2].replace(',', '.')) / 60;
      var lng = +dm[4] + parseFloat(dm[5].replace(',', '.')) / 60;
      if (dm[3].toUpperCase() === 'S') lat = -lat;
      if (dm[6].toUpperCase() === 'W') lng = -lng;
      return { lat: lat, lng: lng };
    }

    // Format 2: Degrees + minutes + seconds — 36°44'54'' N, 28°56'34'' E
    var dms = text.match(
      /(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['''′´`]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:['''′´`]{1,2}|")\s*([NSns])\s*[–—\-,;\/\s]+\s*(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['''′´`]\s*(\d{1,2}(?:[.,]\d+)?)\s*(?:['''′´`]{1,2}|")\s*([EWew])/
    );
    if (dms) {
      var lat = +dms[1] + (+dms[2]) / 60 + parseFloat(dms[3].replace(',', '.')) / 3600;
      var lng = +dms[5] + (+dms[6]) / 60 + parseFloat(dms[7].replace(',', '.')) / 3600;
      if (dms[4].toUpperCase() === 'S') lat = -lat;
      if (dms[8].toUpperCase() === 'W') lng = -lng;
      return { lat: lat, lng: lng };
    }

    // Format 3: Decimal degrees — 36.1968 N, 29.8470 E
    var dd = text.match(
      /(\d{1,3}[.,]\d+)\s*[°]?\s*([NSns])\s*[,;\/\s–—\-]+\s*(\d{1,3}[.,]\d+)\s*[°]?\s*([EWew])/
    );
    if (dd) {
      var dlat = parseFloat(dd[1].replace(',', '.'));
      var dlng = parseFloat(dd[3].replace(',', '.'));
      if (dd[2].toUpperCase() === 'S') dlat = -dlat;
      if (dd[4].toUpperCase() === 'W') dlng = -dlng;
      return { lat: dlat, lng: dlng };
    }

    return null;
  }

  // Try multiple fields in priority order
  function extractCoords(post) {
    // Only source: codeinjection_head
    var raw = post.codeinjection_head;
    if (!raw) return null;

    // Extract content from meta tag if present
    // Use double-quote only matching since Ghost always wraps attributes in double quotes
    // e.g. <meta name="geo.position" content="36° 10.66' N - 29° 51.45' E">
    var metaMatch = raw.match(/content\s*=\s*"([^"]+)"/i);
    var text = metaMatch ? metaMatch[1] : raw;

    var coords = parseCoordinates(text);
    if (coords) return { coords: coords, raw: text.replace(/<[^>]+>/g, '').trim() };
    return null;
  }


  // ══════════════════════════════════════════════════════════════
  // GHOST CONTENT API
  // ══════════════════════════════════════════════════════════════

  function fetchAllGhostPosts() {
    var page = 1;
    var all = [];

    function fetchPage(p) {
      var url = GHOST_URL + '/ghost/api/content/posts/' +
        '?key=' + GHOST_KEY +
        '&fields=id,title,slug,html,feature_image,custom_excerpt,visibility,codeinjection_head' +
        '&include=tags' +
        '&limit=100' +
        '&page=' + p +
        '&formats=html';

      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('Ghost API ' + r.status);
        return r.json();
      }).then(function (data) {
        var posts = data.posts || [];
        all = all.concat(posts);
        if (data.meta && data.meta.pagination && data.meta.pagination.next) {
          return fetchPage(data.meta.pagination.next);
        }
        return all;
      });
    }

    return fetchPage(1);
  }

  function processGhostPosts(posts) {
    var places = [];
    // Tags to exclude from category filters (meta tags, not content types)
    var EXCLUDE_TAGS = config.excludeTags || ['Featured'];

    posts.forEach(function (post) {
      // Extract coordinates from codeinjection_head only
      var coordResult = extractCoords(post);
      if (!coordResult) return;

      var tagNames = (post.tags || []).map(function (t) { return t.name; });

      // Separate region tags from category tags
      var regionTags = [];
      var catTags = [];
      tagNames.forEach(function (name) {
        if (REGION_RE.test(name)) {
          regionTags.push(name);
        } else if (EXCLUDE_TAGS.indexOf(name) === -1) {
          catTags.push(name);
        }
      });

      if (catTags.length === 0) return; // No category → skip

      var primaryCat = catTags[0];
      var region = regionTags[0] || '';

      var access = 'free';
      if (post.visibility === 'paid') access = 'paid';
      else if (post.visibility === 'members') access = 'members';

      // Excerpt: use custom_excerpt if it's text (not coordinates),
      // otherwise extract first paragraph from html
      var excerpt = '';
      if (post.custom_excerpt && !parseCoordinates(post.custom_excerpt)) {
        excerpt = post.custom_excerpt.trim();
      } else if (post.html) {
        var pMatch = post.html.match(/<p[^>]*>(.*?)<\/p>/i);
        if (pMatch) {
          excerpt = pMatch[1].replace(/<[^>]+>/g, '').substring(0, 140);
          if (excerpt.length >= 140) excerpt += '…';
        }
      }

      // Register category — use Ghost tag accent_color if available
      if (!categories[primaryCat]) {
        var ghostTag = (post.tags || []).find(function (t) { return t.name === primaryCat; });
        var color = USER_COLORS[primaryCat]
          || (ghostTag && ghostTag.accent_color)
          || COLOR_POOL[colorIndex % COLOR_POOL.length];
        if (!USER_COLORS[primaryCat] && !(ghostTag && ghostTag.accent_color)) colorIndex++;
        categories[primaryCat] = { color: color, count: 0 };
      }
      categories[primaryCat].count++;

      places.push({
        id: post.id,
        title: post.title,
        slug: post.slug,
        coords: coordResult.coords,
        coordsText: coordResult.raw,
        category: primaryCat,
        region: region,
        allTags: catTags,
        access: access,
        featureImage: post.feature_image || '',
        excerpt: excerpt,
        link: BASE_URL + '/' + post.slug + '/'
      });
    });

    return places;
  }


  // ══════════════════════════════════════════════════════════════
  // MAP INIT
  // ══════════════════════════════════════════════════════════════

  var map = new mapboxgl.Map({
    container: 'map',
    style: STYLE_STREETS,
    center: CENTER,
    zoom: ZOOM
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(new mapboxgl.ScaleControl({ unit: 'nautical' }), 'bottom-right');


  // ══════════════════════════════════════════════════════════════
  // UI: SEARCH
  // ══════════════════════════════════════════════════════════════

  var searchWrap = document.createElement('div');
  searchWrap.className = 'search-wrap';
  searchWrap.innerHTML =
    '<div class="search-inner">' +
      '<div class="search-box">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>' +
        '<input type="text" placeholder="Search places…" id="search-input" autocomplete="off" />' +
        '<button class="search-clear" id="search-clear">&times;</button>' +
      '</div>' +
      '<div class="search-results" id="search-results"></div>' +
    '</div>';
  document.getElementById('map').appendChild(searchWrap);

  var searchInput   = document.getElementById('search-input');
  var searchResults = document.getElementById('search-results');
  var searchClear   = document.getElementById('search-clear');

  searchInput.addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    searchClear.classList.toggle('visible', q.length > 0);

    if (q.length < 2) {
      searchResults.classList.remove('open');
      return;
    }

    var matches = allPlaces.filter(function (p) {
      return p.title.toLowerCase().indexOf(q) !== -1 ||
             p.region.toLowerCase().indexOf(q) !== -1 ||
             p.category.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);

    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-no-results">No places found</div>';
      searchResults.classList.add('open');
      return;
    }

    searchResults.innerHTML = matches.map(function (p) {
      var cat = categories[p.category] || {};
      return '<div class="search-result-item" data-id="' + p.id + '">' +
        '<div class="search-result-dot" style="background:' + (cat.color || '#888') + '"></div>' +
        '<div class="search-result-text">' +
          '<div class="search-result-name">' + highlight(p.title, q) + '</div>' +
          '<div class="search-result-sub">' + (p.region || p.category) + '</div>' +
        '</div></div>';
    }).join('');

    searchResults.classList.add('open');
  });

  searchResults.addEventListener('click', function (e) {
    var item = e.target.closest('.search-result-item');
    if (!item) return;
    var id = item.dataset.id;
    var place = allPlaces.find(function (p) { return p.id === id; });
    if (!place) return;

    map.flyTo({ center: [place.coords.lng, place.coords.lat], zoom: 14, duration: 1200 });
    searchInput.value = '';
    searchClear.classList.remove('visible');
    searchResults.classList.remove('open');

    // Open popup after fly animation
    setTimeout(function () {
      var popup = new mapboxgl.Popup({ offset: 18, maxWidth: '280px', closeButton: true })
        .setLngLat([place.coords.lng, place.coords.lat])
        .setHTML(buildPopupHTML(place))
        .addTo(map);
    }, 1300);
  });

  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    searchClear.classList.remove('visible');
    searchResults.classList.remove('open');
  });

  document.addEventListener('click', function (e) {
    if (!searchWrap.contains(e.target)) searchResults.classList.remove('open');
  });

  function highlight(text, query) {
    var idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return text;
    return text.substring(0, idx) +
      '<strong>' + text.substring(idx, idx + query.length) + '</strong>' +
      text.substring(idx + query.length);
  }


  // ══════════════════════════════════════════════════════════════
  // UI: TOOL BUTTONS (satellite + measure)
  // ══════════════════════════════════════════════════════════════

  var ctrlTools = document.createElement('div');
  ctrlTools.className = 'ctrl-tools';
  document.getElementById('map').appendChild(ctrlTools);

  // Satellite — icon only
  var satBtn = document.createElement('button');
  satBtn.className = 'ctrl-icon-btn';
  satBtn.title = 'Satellite view';
  satBtn.innerHTML = '🛰';
  satBtn.addEventListener('click', function () {
    if (currentStyle === 'streets') {
      map.setStyle(STYLE_SATELLITE);
      currentStyle = 'satellite';
      satBtn.classList.add('active');
      satBtn.title = 'Map view';
    } else {
      map.setStyle(STYLE_STREETS);
      currentStyle = 'streets';
      satBtn.classList.remove('active');
      satBtn.title = 'Satellite view';
    }
    map.once('style.load', function () {
      addRadiusSource();
      renderMarkers();
    });
  });
  ctrlTools.appendChild(satBtn);

  // Measure — icon only
  var measBtn = document.createElement('button');
  measBtn.className = 'ctrl-icon-btn';
  measBtn.title = 'Measure distance';
  measBtn.innerHTML = '📏';
  measBtn.addEventListener('click', function () {
    measureActive = !measureActive;
    measBtn.classList.toggle('active', measureActive);
    measureActive ? enableMeasure() : disableMeasure();
  });
  ctrlTools.appendChild(measBtn);


  // ══════════════════════════════════════════════════════════════
  // UI: FILTER BAR (dynamic)
  // ══════════════════════════════════════════════════════════════

  var filterBar = document.createElement('div');
  filterBar.className = 'filter-bar';
  filterBar.id = 'filter-bar';
  document.getElementById('map').appendChild(filterBar);

  function buildFilters() {
    var html = '<button class="filter-pill active" data-filter="all">All <span class="filter-count">(' + allPlaces.length + ')</span></button>';
    var sortedCats = Object.keys(categories).sort(function (a, b) {
      return categories[b].count - categories[a].count;
    });
    sortedCats.forEach(function (name) {
      var cat = categories[name];
      html += '<button class="filter-pill" data-filter="' + name + '">' +
        '<span class="filter-dot" style="background:' + cat.color + '"></span>' +
        name.replace(/_/g, ' ') + ' <span class="filter-count">(' + cat.count + ')</span></button>';
    });
    filterBar.innerHTML = html;

    filterBar.querySelectorAll('.filter-pill').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filterBar.querySelectorAll('.filter-pill').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        activeFilter = this.dataset.filter;
        renderMarkers();
      });
    });
  }


  // ══════════════════════════════════════════════════════════════
  // UI: GPS + RANGE RING
  // ══════════════════════════════════════════════════════════════

  // GPS button
  var gpsWrap = document.createElement('div');
  gpsWrap.className = 'ctrl-gps';
  var gpsBtn = document.createElement('button');
  gpsBtn.className = 'gps-btn';
  gpsBtn.title = 'Show my position';
  gpsBtn.innerHTML = '📍';
  gpsWrap.appendChild(gpsBtn);
  document.getElementById('map').appendChild(gpsWrap);

  // Range panel
  var rangePanel = document.createElement('div');
  rangePanel.className = 'range-panel';
  rangePanel.innerHTML =
    '<span class="range-label">Range</span>' +
    '<input type="range" min="1" max="30" value="5" step="1" id="range-slider" />' +
    '<span class="range-value" id="range-value">5 <span>nm</span></span>' +
    '<button class="range-close" id="range-close" title="Close">&times;</button>';
  document.getElementById('map').appendChild(rangePanel);

  var rangeSlider = document.getElementById('range-slider');
  var rangeValueEl = document.getElementById('range-value');

  rangeSlider.addEventListener('input', function () {
    radiusNm = parseInt(this.value, 10);
    rangeValueEl.innerHTML = radiusNm + ' <span>nm</span>';
    updateRadiusRing();
  });

  document.getElementById('range-close').addEventListener('click', function () {
    deactivateGPS();
  });

  gpsBtn.addEventListener('click', function () {
    if (gpsPosition) {
      deactivateGPS();
      return;
    }
    gpsBtn.title = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        gpsPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        activateGPS();
      },
      function (err) {
        console.warn('[BayExpress] Geolocation error:', err.message);
        gpsBtn.title = 'Location unavailable';
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  function activateGPS() {
    gpsBtn.classList.add('active');
    gpsBtn.title = 'Hide position';

    // Add GPS marker
    if (gpsMarker) gpsMarker.remove();
    var el = document.createElement('div');
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" fill="#378ADD" stroke="#fff" stroke-width="3"/></svg>';
    el.style.cursor = 'default';
    gpsMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([gpsPosition.lng, gpsPosition.lat])
      .addTo(map);

    // Show range panel
    rangePanel.classList.add('visible');

    // Add/update range ring
    updateRadiusRing();

    // Center on position
    map.flyTo({ center: [gpsPosition.lng, gpsPosition.lat], zoom: 11, duration: 1000 });
  }

  function deactivateGPS() {
    gpsBtn.classList.remove('active');
    gpsBtn.title = 'Show my position';
    gpsPosition = null;
    if (gpsMarker) { gpsMarker.remove(); gpsMarker = null; }
    rangePanel.classList.remove('visible');
    removeRadiusRing();
  }

  function addRadiusSource() {
    if (map.getSource('radius-ring')) return;
    map.addSource('radius-ring', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'radius-ring-fill',
      type: 'fill',
      source: 'radius-ring',
      paint: {
        'fill-color': '#378ADD',
        'fill-opacity': 0.06
      }
    });
    map.addLayer({
      id: 'radius-ring-line',
      type: 'line',
      source: 'radius-ring',
      paint: {
        'line-color': '#378ADD',
        'line-width': 2,
        'line-dasharray': [4, 3],
        'line-opacity': 0.5
      }
    });
  }

  function updateRadiusRing() {
    if (!gpsPosition) return;
    var src = map.getSource('radius-ring');
    if (!src) {
      addRadiusSource();
      src = map.getSource('radius-ring');
    }
    if (!src) return;

    var radiusKm = radiusNm * 1.852;
    var center = turf.point([gpsPosition.lng, gpsPosition.lat]);
    var circle = turf.circle(center, radiusKm, { units: 'kilometers', steps: 80 });
    src.setData(circle);
  }

  function removeRadiusRing() {
    var src = map.getSource('radius-ring');
    if (src) {
      src.setData({ type: 'FeatureCollection', features: [] });
    }
  }


  // ══════════════════════════════════════════════════════════════
  // MEASURE TOOL (preserved from original)
  // ══════════════════════════════════════════════════════════════

  var measPanel = document.createElement('div');
  measPanel.className = 'measure-panel';
  measPanel.innerHTML =
    '<h4>Distance</h4>' +
    '<p class="measure-value">—</p>' +
    '<p class="measure-bearing"></p>' +
    '<button class="measure-clear">Clear</button>';
  document.getElementById('map').appendChild(measPanel);

  measPanel.querySelector('.measure-clear').addEventListener('click', function () {
    if (draw) { draw.deleteAll(); updateMeasurement(); draw.changeMode('draw_line_string'); }
  });

  function enableMeasure() {
    if (!draw) {
      draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: 'draw_line_string',
        styles: [
          { id: 'gl-draw-line', type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
            paint: { 'line-color': '#c8a860', 'line-width': 3, 'line-dasharray': [2, 2] } },
          { id: 'gl-draw-line-static', type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['==', 'mode', 'static']],
            paint: { 'line-color': '#c8a860', 'line-width': 3 } },
          { id: 'gl-draw-point', type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
            paint: { 'circle-radius': 5, 'circle-color': '#c8a860', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
          { id: 'gl-draw-point-mid', type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: { 'circle-radius': 3, 'circle-color': '#c8a860' } }
        ]
      });
      map.addControl(draw);
      map.on('draw.create', updateMeasurement);
      map.on('draw.update', updateMeasurement);
      map.on('draw.delete', updateMeasurement);
      map.on('draw.render', updateMeasurement);
    } else {
      draw.changeMode('draw_line_string');
    }
    measPanel.classList.add('active');
    map.getCanvas().style.cursor = 'crosshair';
  }

  function disableMeasure() {
    if (draw) {
      draw.deleteAll();
      map.removeControl(draw);
      draw = null;
    }
    measPanel.classList.remove('active');
    map.getCanvas().style.cursor = '';
  }

  function updateMeasurement() {
    if (!draw) return;
    var data = draw.getAll();
    var valEl = measPanel.querySelector('.measure-value');
    var brEl  = measPanel.querySelector('.measure-bearing');

    if (!data.features.length || data.features[0].geometry.coordinates.length < 2) {
      valEl.innerHTML = '—';
      brEl.textContent = '';
      return;
    }
    var line = data.features[0];
    var coords = line.geometry.coordinates;
    var km = turf.length(line, { units: 'kilometers' });
    var nm = km / 1.852;
    valEl.innerHTML = nm.toFixed(1) + ' <span>nm</span>';

    var bearing = turf.bearing(turf.point(coords[0]), turf.point(coords[coords.length - 1]));
    if (bearing < 0) bearing += 360;
    var dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    brEl.textContent = 'Bearing: ' + Math.round(bearing) + '° ' + dirs[Math.round(bearing / 22.5) % 16];
  }


  // ══════════════════════════════════════════════════════════════
  // MODAL (preserved from original)
  // ══════════════════════════════════════════════════════════════

  var modal = document.createElement('div');
  modal.className = 'map-modal';
  modal.innerHTML =
    '<div class="map-modal-backdrop"></div>' +
    '<div class="map-modal-content">' +
      '<button class="map-modal-close">&times;</button>' +
      '<iframe class="map-modal-iframe"></iframe>' +
    '</div>';
  document.body.appendChild(modal);

  modal.querySelector('.map-modal-backdrop').addEventListener('click', closeModal);
  modal.querySelector('.map-modal-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function openModal(url) {
    modal.querySelector('.map-modal-iframe').src = url;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    modal.classList.remove('active');
    modal.querySelector('.map-modal-iframe').src = '';
    document.body.style.overflow = '';
  }


  // ══════════════════════════════════════════════════════════════
  // POPUPS
  // ══════════════════════════════════════════════════════════════

  function buildPopupHTML(place) {
    var cat = categories[place.category] || {};
    var catColor = cat.color || '#888';

    // Generate a light background from the category color
    var tagBg = hexToLight(catColor);

    var imgHTML = place.featureImage
      ? '<img class="popup-card-img" src="' + place.featureImage + '" alt="" onerror="this.style.display=\'none\'" />'
      : '';

    var tagsHTML = '<span class="popup-tag" style="background:' + tagBg + ';color:' + catColor + '">' + place.category.replace(/_/g, ' ') + '</span>';
    if (place.region) tagsHTML += '<span class="popup-tag popup-tag-region">' + place.region + '</span>';
    if (place.access === 'paid') tagsHTML += '<span class="popup-tag popup-tag-access-paid">Paid</span>';
    else if (place.access === 'members') tagsHTML += '<span class="popup-tag popup-tag-access-members">Members</span>';

    var coordsHTML = place.coordsText ? '<p class="popup-coords">' + place.coordsText + '</p>' : '';
    var excerptHTML = place.excerpt ? '<p class="popup-excerpt">' + place.excerpt + '</p>' : '';

    return '<div class="popup-card">' + imgHTML +
      '<div class="popup-body">' +
        '<div class="popup-tags">' + tagsHTML + '</div>' +
        '<h3>' + place.title + '</h3>' +
        coordsHTML + excerptHTML +
        '<a class="popup-link" href="' + place.link + '" target="_blank">Read full article →</a>' +
      '</div></div>';
  }

  function hexToLight(hex) {
    // Convert hex to a very light tint for tag backgrounds
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    r = Math.round(r + (255 - r) * 0.82);
    g = Math.round(g + (255 - g) * 0.82);
    b = Math.round(b + (255 - b) * 0.82);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }


  // ══════════════════════════════════════════════════════════════
  // CLUSTERING + MARKERS
  // ══════════════════════════════════════════════════════════════

  function buildClusterIndex(places) {
    var points = places.map(function (p, i) {
      return {
        type: 'Feature',
        properties: { index: i },
        geometry: { type: 'Point', coordinates: [p.coords.lng, p.coords.lat] }
      };
    });

    clusterIndex = new Supercluster({
      radius: 50,
      maxZoom: 14,
      minPoints: 3
    });
    clusterIndex.load(points);
  }

  function getFilteredPlaces() {
    if (activeFilter === 'all') return allPlaces;
    return allPlaces.filter(function (p) { return p.category === activeFilter; });
  }

  function clearMarkers() {
    mapMarkers.forEach(function (m) { m.remove(); });
    mapMarkers = [];
  }

  function renderMarkers() {
    clearMarkers();

    var filtered = getFilteredPlaces();
    buildClusterIndex(filtered);

    var bounds = map.getBounds();
    var zoom = Math.floor(map.getZoom());

    var clusters = clusterIndex.getClusters(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      zoom
    );

    clusters.forEach(function (feature) {
      var coords = feature.geometry.coordinates;

      if (feature.properties.cluster) {
        // ── Cluster marker ──
        var count = feature.properties.point_count;
        var size = count < 10 ? 34 : count < 50 ? 42 : 50;
        var el = document.createElement('div');
        el.className = 'cluster-marker';
        el.style.width = size + 'px';
        el.style.height = size + 'px';
        el.textContent = count;

        el.addEventListener('click', function () {
          var expansionZoom = clusterIndex.getClusterExpansionZoom(feature.properties.cluster_id);
          map.flyTo({ center: coords, zoom: Math.min(expansionZoom, 16), duration: 600 });
        });

        var marker = new mapboxgl.Marker(el).setLngLat(coords).addTo(map);
        mapMarkers.push(marker);

      } else {
        // ── Single marker ──
        var place = filtered[feature.properties.index];
        if (!place) return;

        var cat = categories[place.category] || {};
        var el = document.createElement('div');
        el.className = 'marker-icon';
        el.style.background = cat.color || '#888';
        el.title = place.title;

        var popup = new mapboxgl.Popup({ offset: 16, maxWidth: '280px', closeButton: true })
          .setHTML(buildPopupHTML(place));

        var marker = new mapboxgl.Marker(el)
          .setLngLat(coords)
          .setPopup(popup)
          .addTo(map);

        mapMarkers.push(marker);
      }
    });
  }

  // Re-render on zoom/move for clustering
  var renderTimeout = null;
  function scheduleRender() {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(renderMarkers, 150);
  }


  // ══════════════════════════════════════════════════════════════
  // INIT: Load from Ghost and boot
  // ══════════════════════════════════════════════════════════════

  map.on('load', function () {
    addRadiusSource();

    var loadingEl = document.getElementById('loading-overlay');

    fetchAllGhostPosts()
      .then(function (posts) {
        allPlaces = processGhostPosts(posts);
        console.log('[BayExpress] Loaded ' + allPlaces.length + ' places with coordinates from ' + posts.length + ' Ghost posts.');

        var skipped = posts.length - allPlaces.length;
        if (skipped > 0) console.log('[BayExpress] ' + skipped + ' posts skipped (no coordinates or no category tag).');
        console.log('[BayExpress] Categories:', Object.keys(categories).join(', '));

        buildFilters();
        renderMarkers();

        // Fit bounds
        if (allPlaces.length > 0) {
          var bounds = new mapboxgl.LngLatBounds();
          allPlaces.forEach(function (p) { bounds.extend([p.coords.lng, p.coords.lat]); });
          map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
        }

        if (loadingEl) loadingEl.classList.add('hidden');

        // Attach move listener for clustering after initial render
        map.on('moveend', scheduleRender);
        map.on('zoomend', scheduleRender);
      })
      .catch(function (err) {
        console.error('[BayExpress] Error:', err);
        if (loadingEl) {
          loadingEl.querySelector('p').textContent = '⚠ Could not load data. Check console.';
          loadingEl.querySelector('.loading-spinner').style.display = 'none';
        }
      });
  });

})();