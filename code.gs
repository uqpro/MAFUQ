/*******************************************************
 * MASJID FINDER - GOOGLE APPS SCRIPT BACKEND (Code.gs)
 *******************************************************/

const CONFIG = {
  APP_NAME: 'Masjid Finder API',
  SHEET_NAME: 'TEMPAT_IBADAH',
  DEFAULT_RADIUS: 5000,
  OVERPASS_ENDPOINTS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ],
  HEADERS: [
    'ID', 'NAMA', 'JENIS', 'ALAMAT', 'LATITUDE', 'LONGITUDE',
    'KOTA', 'PROVINSI', 'TELEPON', 'KETERANGAN', 'SUMBER', 'CREATED_AT'
  ]
};

/**
 * REST API Endpoint GET (untuk Web App / Fetch GET)
 */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action ? e.parameter.action : 'getPlaces';
  
  if (action === 'getPlaces') {
    const lat = e.parameter.lat;
    const lon = e.parameter.lon;
    const radius = e.parameter.radius || CONFIG.DEFAULT_RADIUS;
    const data = getPlaces(lat, lon, radius);
    return createJsonResponse({ success: true, data: data });
  }

  if (action === 'getLocalPlaces') {
    const data = getLocalPlaces();
    return createJsonResponse({ success: true, data: data });
  }

  return createJsonResponse({ success: true, message: 'Masjid Finder API Active' });
}

/**
 * REST API Endpoint POST (Untuk menerima request simpan data dari GitHub Pages)
 */
function doPost(e) {
  try {
    let contents;
    if (e.postData && e.postData.contents) {
      contents = JSON.parse(e.postData.contents);
    } else {
      contents = e.parameter;
    }

    const action = contents.action || 'addPlace';

    if (action === 'addPlace') {
      const result = addPlace(contents.place || contents);
      return createJsonResponse(result);
    }

    return createJsonResponse({ success: false, message: 'Aksi tidak dikenali.' });
  } catch (err) {
    return createJsonResponse({ success: false, message: err.message });
  }
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  }

  sheet.clear();
  sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]);
  sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  return { success: true, message: 'Database berhasil dibuat.' };
}

function getLocalPlaces() {
  try {
    const sheet = getDatabaseSheet();
    const values = sheet.getDataRange().getValues();

    if (values.length <= 1) return [];

    const headers = values[0];
    return values.slice(1)
      .filter(row => row[0] || row[1])
      .map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = row[index];
        });
        return normalizePlace(obj);
      })
      .filter(Boolean);
  } catch (e) {
    console.error('Error getLocalPlaces: ' + e.message);
    return [];
  }
}

function getOSMPlaces(lat, lon, radius) {
  lat = parseCoordinate(lat);
  lon = parseCoordinate(lon);
  radius = Number(radius) || CONFIG.DEFAULT_RADIUS;

  if (!isFinite(lat) || !isFinite(lon) || lat === 0 || lon === 0) return [];

  const query = `[out:json][timeout:15];(node["amenity"~"mosque|place_of_worship|prayer_room"](around:${radius},${lat},${lon});way["amenity"~"mosque|place_of_worship|prayer_room"](around:${radius},${lat},${lon}););out center tags;`;

  let response = null;
  for (const url of CONFIG.OVERPASS_ENDPOINTS) {
    try {
      response = UrlFetchApp.fetch(url, {
        method: 'post',
        payload: { data: query },
        muteHttpExceptions: true
      });
      if (response && response.getResponseCode() === 200) break;
    } catch (e) {
      console.warn('Gagal endpoint OSM: ' + e.message);
    }
  }

  if (!response || response.getResponseCode() !== 200) return [];

  try {
    const json = JSON.parse(response.getContentText());
    return (json.elements || []).map(element => {
      let elemLat = element.lat || (element.center && element.center.lat);
      let elemLon = element.lon || (element.center && element.center.lon);

      if (typeof elemLat !== 'number' || typeof elemLon !== 'number') return null;

      const tags = element.tags || {};
      if (tags.amenity === 'place_of_worship' && tags.religion && tags.religion !== 'muslim') return null;

      return {
        ID: 'OSM-' + element.type + '-' + element.id,
        NAMA: tags.name || tags['name:id'] || 'Tempat Ibadah',
        JENIS: detectPlaceType(tags),
        ALAMAT: buildOSMAddress(tags),
        LATITUDE: elemLat,
        LONGITUDE: elemLon,
        SUMBER: 'OpenStreetMap'
      };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function detectPlaceType(tags) {
  if (!tags) return 'Tempat Ibadah';
  let name = typeof tags === 'string' ? tags.toLowerCase() : String(tags.name || tags.NAMA || '').toLowerCase();
  
  if (name.includes('mushola') || name.includes('musholla') || name.includes('musala')) return 'Mushola';
  if (name.includes('langgar')) return 'Langgar';
  if (name.includes('surau')) return 'Surau';
  if (name.includes('masjid')) return 'Masjid';

  return 'Tempat Ibadah';
}

function buildOSMAddress(tags) {
  if (!tags) return '';
  return [
    tags['addr:street'] ? 'Jl. ' + tags['addr:street'] : '',
    tags['addr:suburb'] || tags['addr:village'],
    tags['addr:city'] || tags['addr:town']
  ].filter(Boolean).join(', ');
}

function addPlace(place) {
  if (!place) throw new Error('Data tidak valid.');
  const name = String(place.nama || place.NAMA || '').trim();
  const jenis = String(place.jenis || place.JENIS || detectPlaceType(name)).trim();
  const lat = parseCoordinate(place.latitude || place.LATITUDE);
  const lon = parseCoordinate(place.longitude || place.LONGITUDE);

  if (!name || !lat || !lon) throw new Error('Nama dan Koordinat wajib diisi.');

  const sheet = getDatabaseSheet();
  const id = 'MF-' + Utilities.getUuid();

  sheet.appendRow([
    id, name, jenis, String(place.alamat || place.ALAMAT || '').trim(),
    lat, lon, String(place.kota || '').trim(), String(place.provinsi || '').trim(),
    String(place.telepon || '').trim(), String(place.keterangan || '').trim(),
    'Input User', new Date()
  ]);

  return {
    success: true,
    message: 'Tempat ibadah berhasil ditambahkan.',
    place: { ID: id, NAMA: name, JENIS: jenis, ALAMAT: place.alamat || '', LATITUDE: lat, LONGITUDE: lon, SUMBER: 'Input User' }
  };
}

function getPlaces(lat, lon, radius) {
  const localPlaces = getLocalPlaces();
  let osmPlaces = [];
  if (lat && lon) {
    osmPlaces = getOSMPlaces(lat, lon, radius);
  }
  return mergePlaces(localPlaces, osmPlaces);
}

function mergePlaces(localPlaces, osmPlaces) {
  const result = [];
  const idMap = {};
  [...localPlaces, ...osmPlaces].forEach(p => {
    if (!p) return;
    const lat = parseCoordinate(p.LATITUDE);
    const lon = parseCoordinate(p.LONGITUDE);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return;

    const key = p.ID || (p.NAMA + lat + lon);
    if (!idMap[key]) {
      idMap[key] = true;
      result.push(p);
    }
  });
  return result;
}

function getDatabaseSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).setValues([CONFIG.HEADERS]).setFontWeight('bold');
  }
  return sheet;
}

function parseCoordinate(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const parsed = parseFloat(String(val).replace(',', '.').trim());
  return isFinite(parsed) ? parsed : 0;
}

function normalizePlace(place) {
  if (!place) return null;
  return {
    ID: String(place.ID || ''),
    NAMA: String(place.NAMA || ''),
    JENIS: String(place.JENIS || detectPlaceType(place.NAMA)),
    ALAMAT: String(place.ALAMAT || ''),
    LATITUDE: parseCoordinate(place.LATITUDE),
    LONGITUDE: parseCoordinate(place.LONGITUDE),
    SUMBER: String(place.SUMBER || 'Spreadsheet')
  };
}