/* Bayexpress Interactive Sailing Map */

(function () {
  'use strict';

  // ── Config ──
  var config = window.BAYEXPRESS_MAP || {};
  if (!config.token) {
    console.error('BAYEXPRESS_MAP: No Mapbox token provided.');
    return;
  }

  mapboxgl.accessToken = config.token;

  var CENTER = config.center || [28.3, 36.85];
  var ZOOM = config.zoom || 8;

  // ── Region Data ──
  var regions = [
    {
      name: 'Bodrum',
      coords: [27.4295, 37.0344],
      description: 'Historic peninsula with vibrant marina life',
      tag: 'bodrum-region'
    },
    {
      name: 'Datça',
      coords: [27.6870, 36.7260],
      description: 'Unspoiled peninsula between two seas',
      tag: 'datca-region'
    },
    {
      name: 'Bozburun',
      coords: [28.0570, 36.6880],
      description: 'Traditional gulet-building village',
      tag: 'bozburun-region'
    },
    {
      name: 'Marmaris',
      coords: [28.2740, 36.8510],
      description: 'Major charter hub and marina town',
      tag: 'marmaris-region'
    },
    {
      name: 'Göcek',
      coords: [28.9400, 36.7550],
      description: 'Sheltered bay with world-class marinas',
      tag: 'gocek-region'
    },
    {
      name: 'Fethiye',
      coords: [29.1145, 36.6515],
      description: 'Gateway to the Twelve Islands',
      tag: 'fethiye-region'
    },
    {
      name: 'Kaş',
      coords: [29.6380, 36.2000],
      description: 'Charming harbour town near Greek islands',
      tag: 'kas-region'
    },
    {
      name: 'Greek Dodecanese',
      coords: [27.1350, 36.8930],
      description: 'Kos, Rhodes, Symi and more',
      tag: 'greek-dodecanese-islands'
    }
  ];

  // ── Map Styles ──
  var STYLE_STREETS = 'mapbox://styles/mapbox/streets-v12';
  var STYLE_SATELLITE = 'mapbox://styles/mapbox/satellite-streets-v12';
  var currentStyle = 'streets';

  // ── State ──
  var draw = null;
  var measureActive = false;

  // ── Initialize Map ──
  var map = new mapboxgl.Map({
    container: 'map',
    style: STYLE_STREETS,
    center: CENTER,
    zoom: ZOOM
  });

  map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  map.addControl(new mapboxgl.ScaleControl({ unit: 'nautical' }), 'bottom-right');

  // ── Satellite Toggle ──
  var styleBtn = document.createElement('button');
  styleBtn.className = 'map-style-toggle';
  styleBtn.textContent = '🛰 Satellite';
  styleBtn.addEventListener('click', function () {
    if (currentStyle === 'streets') {
      map.setStyle(STYLE_SATELLITE);
      currentStyle = 'satellite';
      styleBtn.textContent = '🗺 Map';
    } else {
      map.setStyle(STYLE_STREETS);
      currentStyle = 'streets';
      styleBtn.textContent = '🛰 Satellite';
    }
    // Re-add markers after style change
    map.once('style.load', function () {
      addMarkers();
    });
  });
  document.getElementById('map').appendChild(styleBtn);

  // ── Measure Toggle Button ──
  var measureBtn = document.createElement('button');
  measureBtn.className = 'measure-toggle';
  measureBtn.textContent = '📏 Measure';
  measureBtn.addEventListener('click', function () {
    measureActive = !measureActive;
    measureBtn.classList.toggle('active', measureActive);
    if (measureActive) {
      enableMeasure();
    } else {
      disableMeasure();
    }
  });
  document.getElementById('map').appendChild(measureBtn);

  // ── Measure Panel ──
  var panel = document.createElement('div');
  panel.className = 'measure-panel';
  panel.innerHTML =
    '<h4>Distance</h4>' +
    '<p class="measure-value">—</p>' +
    '<p class="measure-bearing"></p>' +
    '<button class="measure-clear">Clear</button>';
  document.getElementById('map').appendChild(panel);

  panel.querySelector('.measure-clear').addEventListener('click', function () {
    if (draw) {
      draw.deleteAll();
      updateMeasurement();
    }
  });

  // ── Measure Functions ──
  function enableMeasure() {
    if (!draw) {
      draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: 'draw_line_string',
        styles: [
          {
            id: 'gl-draw-line',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
            paint: { 'line-color': '#c8a860', 'line-width': 3, 'line-dasharray': [2, 2] }
          },
          {
            id: 'gl-draw-line-static',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['==', 'mode', 'static']],
            paint: { 'line-color': '#c8a860', 'line-width': 3 }
          },
          {
            id: 'gl-draw-point',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
            paint: { 'circle-radius': 5, 'circle-color': '#c8a860', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }
          },
          {
            id: 'gl-draw-point-mid',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: { 'circle-radius': 3, 'circle-color': '#c8a860' }
          }
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
    panel.classList.add('active');
    map.getCanvas().style.cursor = 'crosshair';
  }

  function disableMeasure() {
    if (draw) {
      draw.deleteAll();
      map.removeControl(draw);
      draw = null;
    }
    panel.classList.remove('active');
    map.getCanvas().style.cursor = '';
  }

  function updateMeasurement() {
    if (!draw) return;

    var data = draw.getAll();
    var valueEl = panel.querySelector('.measure-value');
    var bearingEl = panel.querySelector('.measure-bearing');

    if (data.features.length === 0) {
      valueEl.innerHTML = '—';
      bearingEl.textContent = '';
      return;
    }

    var line = data.features[0];
    var coords = line.geometry.coordinates;

    if (coords.length < 2) {
      valueEl.innerHTML = '—';
      bearingEl.textContent = '';
      return;
    }

    // Distance in km, then convert to nautical miles
    var distanceKm = turf.length(line, { units: 'kilometers' });
    var distanceNm = distanceKm / 1.852;

    valueEl.innerHTML = distanceNm.toFixed(1) + ' <span>nm</span>';

    // Bearing from first to last point
    var first = turf.point(coords[0]);
    var last = turf.point(coords[coords.length - 1]);
    var bearing = turf.bearing(first, last);
    if (bearing < 0) bearing += 360;
    bearingEl.textContent = 'Bearing: ' + Math.round(bearing) + '° ' + getCompassDirection(bearing);
  }

  function getCompassDirection(deg) {
    var dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    var index = Math.round(deg / 22.5) % 16;
    return dirs[index];
  }

  // ── Markers ──
  var markers = [];

  function addMarkers() {
    // Remove existing markers
    markers.forEach(function (m) { m.remove(); });
    markers = [];

    regions.forEach(function (region) {
      var el = document.createElement('div');
      el.className = 'marker-region';
      el.title = region.name;

      var popup = new mapboxgl.Popup({ offset: 20, maxWidth: '240px' }).setHTML(
        '<div class="popup-region">' +
          '<h3>' + region.name + '</h3>' +
          '<p>' + region.description + '</p>' +
          '<a href="/tag/' + region.tag + '/">Explore region →</a>' +
        '</div>'
      );

      var marker = new mapboxgl.Marker(el)
        .setLngLat(region.coords)
        .setPopup(popup)
        .addTo(map);

      markers.push(marker);
    });
  }

  map.on('load', function () {
    addMarkers();
  });
})();
