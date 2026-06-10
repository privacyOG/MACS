import { deleteQuoteJobs, initAccessibleNavigation, listQuoteJobs, requireAdminSession, saveQuoteJobs } from "./auth.js";

if (!(await requireAdminSession())) {
  throw new Error("Admin login required");
}
await initAccessibleNavigation();

const STORAGE_KEY = "lawnquote.history.v1";
const SETTINGS_KEY = "lawnquote.settings.v1";
const quoteStepLinks = [...document.querySelectorAll(".quote-stepper a")];

const factors = {
  grassHeight: { regular: 1, long: 1.25, overgrown: 1.65 },
  access: { easy: 1, medium: 1.12, hard: 1.28 },
  slope: { flat: 1, mixed: 1.12, steep: 1.35 },
  obstacles: { few: 1, some: 1.12, many: 1.28 },
  cleanup: { light: 0.9, normal: 1, heavy: 1.22 },
  urgency: { normal: 0, soon: 0.08, urgent: 0.18 }
};

const wasteFees = {
  none: 0,
  small: 1,
  large: 2.2
};

const form = document.querySelector("#quote-form");
const zoneList = document.querySelector("#zone-list");
const zoneTemplate = document.querySelector("#zone-template");
const photoInput = document.querySelector("#photo-input");
const photoGrid = document.querySelector("#photo-grid");
const historyList = document.querySelector("#history-list");
const mapDialog = document.querySelector("#map-dialog");
const mapStatus = document.querySelector("#map-status");
const deviceBadge = document.querySelector("#device-badge");
const priceBreakdown = document.querySelector("#price-breakdown");
const jobDialog = document.querySelector("#job-dialog");
const jobDialogTitle = document.querySelector("#job-dialog-title");
const jobDialogMeta = document.querySelector("#job-dialog-meta");
const jobDialogContent = document.querySelector("#job-dialog-content");
const addressSuggestions = document.querySelector("#address-suggestions");
const mapAddressSuggestions = document.querySelector("#map-address-suggestions");
const showBoundaries = document.querySelector("#show-boundaries");
const showAddressLabels = document.querySelector("#show-address-labels");
const showLotLabels = document.querySelector("#show-lot-labels");

const CADASTRE_EXPORT_URL = "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/export";
const PROPERTY_ADDRESS_EXPORT_URL = "https://maps.six.nsw.gov.au/arcgis/rest/services/sixmaps/PropertyAddress/MapServer/export";

const fields = {
  customerName: document.querySelector("#customer-name"),
  customerPhone: document.querySelector("#customer-phone"),
  customerEmail: document.querySelector("#customer-email"),
  address: document.querySelector("#address"),
  jobType: document.querySelector("#job-type"),
  urgency: document.querySelector("#urgency"),
  grassHeight: document.querySelector("#grass-height"),
  access: document.querySelector("#access"),
  slope: document.querySelector("#slope"),
  obstacles: document.querySelector("#obstacles"),
  cleanup: document.querySelector("#cleanup"),
  greenWaste: document.querySelector("#green-waste"),
  travelMinutes: document.querySelector("#travel-minutes"),
  setupMinutes: document.querySelector("#setup-minutes"),
  notes: document.querySelector("#notes"),
  hourlyRate: document.querySelector("#hourly-rate"),
  minimumCharge: document.querySelector("#minimum-charge"),
  wasteFee: document.querySelector("#waste-fee"),
  margin: document.querySelector("#margin")
};

const mapState = {
  map: null,
  layers: null,
  baseLayers: null,
  cadastreOverlay: null,
  addressOverlay: null,
  points: [],
  markers: [],
  polygon: null,
  edgeLine: null,
  targetZone: null,
  lastMeasurement: { area: 0, edging: 0 }
};

let quoteHistory = [];

let addressSearchTimer = null;
let currentQuote = null;
let selectedHistoryId = null;

const results = {
  price: document.querySelector("#result-price"),
  range: document.querySelector("#result-range"),
  time: document.querySelector("#result-time"),
  area: document.querySelector("#result-area"),
  edging: document.querySelector("#result-edging"),
  difficulty: document.querySelector("#result-difficulty"),
  notes: document.querySelector("#quote-notes")
};

function money(value) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function metresLabel(value) {
  return `${Math.round(value)} m`;
}

function squareMetresLabel(value) {
  return `${Math.round(value)} m²`;
}

function minutesLabel(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function detectDevice() {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 0;
  const width = window.innerWidth;
  const isTablet = /iPad|Tablet/i.test(ua) || (touch && width >= 720 && width <= 1180);
  const isMobile = !isTablet && (/Android|iPhone|iPod|Mobile/i.test(ua) || width < 720);
  const type = isMobile ? "mobile" : isTablet ? "tablet" : "desktop";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? "Chrome"
      : /Firefox\//.test(ua) ? "Firefox"
        : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? "Safari"
          : "browser";
  document.body.dataset.device = type;
  document.body.classList.toggle("is-mobile", type === "mobile");
  document.body.classList.toggle("is-tablet", type === "tablet");
  document.body.classList.toggle("is-desktop", type === "desktop");
  deviceBadge.textContent = `${type.toUpperCase()} view · ${browser} · ${Math.round(width)}px wide`;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function quoteId(quote) {
  return quote.id || quote.createdAt;
}

function mergeQuoteHistory(remoteQuotes, localQuotes) {
  const map = new Map();
  for (const quote of remoteQuotes) map.set(quoteId(quote), quote);
  for (const quote of localQuotes) {
    const id = quoteId(quote);
    if (!map.has(id)) map.set(id, quote);
  }
  return [...map.values()];
}

async function refreshQuoteHistory() {
  const localQuotes = loadJson(STORAGE_KEY, []);
  const result = await listQuoteJobs();
  quoteHistory = result.ok ? result.quotes : [];
  if (localQuotes.length) {
    const merged = mergeQuoteHistory(quoteHistory, localQuotes);
    if (merged.length > quoteHistory.length) {
      const saved = await saveQuoteJobs({ quotes: merged });
      quoteHistory = saved.ok ? saved.quotes : merged;
    }
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quoteHistory.slice(0, 250)));
}

function saveSettings() {
  const settings = {
    hourlyRate: fields.hourlyRate.value,
    minimumCharge: fields.minimumCharge.value,
    wasteFee: fields.wasteFee.value,
    margin: fields.margin.value
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function loadSettings() {
  const settings = loadJson(SETTINGS_KEY, {});
  for (const [key, value] of Object.entries(settings)) {
    if (fields[key]) fields[key].value = value;
  }
}

function setFieldValue(field, value) {
  if (value !== undefined && value !== null) field.value = value;
}

function debounceAddressSearch(input, container, onSelect) {
  clearTimeout(addressSearchTimer);
  const query = input.value.trim();
  if (query.length < 4) {
    closeSuggestions(container);
    return;
  }

  addressSearchTimer = setTimeout(() => searchAddressSuggestions(query, container, onSelect), 350);
}

function closeSuggestions(container) {
  container.classList.remove("open");
  container.replaceChildren();
}

async function searchAddressSuggestions(query, container, onSelect) {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("countrycodes", "au");
    url.searchParams.set("limit", "6");
    url.searchParams.set("q", query);
    const response = await fetch(url, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("Address search failed");
    const matches = await response.json();
    renderSuggestions(matches, container, onSelect);
  } catch {
    closeSuggestions(container);
  }
}

function renderSuggestions(matches, container, onSelect) {
  container.replaceChildren();
  if (!matches.length) {
    closeSuggestions(container);
    return;
  }

  for (const match of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "suggestion-option";
    option.setAttribute("role", "option");
    option.textContent = match.display_name;
    option.addEventListener("click", () => {
      onSelect(match);
      closeSuggestions(container);
    });
    container.append(option);
  }
  container.classList.add("open");
}

function createZone(data = {}) {
  const node = zoneTemplate.content.firstElementChild.cloneNode(true);
  if (data.area) node.dataset.mappedArea = String(data.area);
  node.querySelector(".zone-name").value = data.name || "";
  node.querySelector(".zone-length").value = data.length ?? 10;
  node.querySelector(".zone-width").value = data.width ?? 6;
  node.querySelector(".zone-edging").value = data.edging ?? 18;
  node.querySelector(".measure-zone").addEventListener("click", () => openMap(node));
  node.querySelector(".remove-zone").addEventListener("click", () => {
    if (zoneList.children.length > 1) {
      node.remove();
      calculate();
    }
  });
  node.addEventListener("input", (event) => {
    if (event.target.matches(".zone-length, .zone-width")) delete node.dataset.mappedArea;
    calculate();
  });
  zoneList.append(node);
}

function zoneDisplayName(row) {
  return row.querySelector(".zone-name").value.trim() || `Lawn area ${[...zoneList.children].indexOf(row) + 1}`;
}

function getZones() {
  return [...zoneList.querySelectorAll(".zone-row")].map((row) => {
    const length = number(row.querySelector(".zone-length").value);
    const width = number(row.querySelector(".zone-width").value);
    const mappedArea = Number(row.dataset.mappedArea);
    return {
      name: row.querySelector(".zone-name").value.trim(),
      length,
      width,
      edging: number(row.querySelector(".zone-edging").value),
      area: Number.isFinite(mappedArea) && mappedArea > 0 ? mappedArea : length * width
    };
  });
}

function getFormState() {
  return {
    customerName: fields.customerName.value.trim(),
    customerPhone: fields.customerPhone.value.trim(),
    customerEmail: fields.customerEmail.value.trim(),
    address: fields.address.value.trim(),
    jobType: fields.jobType.value,
    urgency: fields.urgency.value,
    grassHeight: fields.grassHeight.value,
    access: fields.access.value,
    slope: fields.slope.value,
    obstacles: fields.obstacles.value,
    cleanup: fields.cleanup.value,
    greenWaste: fields.greenWaste.value,
    travelMinutes: fields.travelMinutes.value,
    setupMinutes: fields.setupMinutes.value,
    notes: fields.notes.value.trim(),
    hourlyRate: fields.hourlyRate.value,
    minimumCharge: fields.minimumCharge.value,
    wasteFee: fields.wasteFee.value,
    margin: fields.margin.value,
    zones: getZones()
  };
}

function loadFormState(state = {}) {
  setFieldValue(fields.customerName, state.customerName);
  setFieldValue(fields.customerPhone, state.customerPhone || state.phone || state.mobile);
  setFieldValue(fields.customerEmail, state.customerEmail || state.email);
  setFieldValue(fields.address, state.address);
  setFieldValue(fields.jobType, state.jobType);
  setFieldValue(fields.urgency, state.urgency);
  setFieldValue(fields.grassHeight, state.grassHeight);
  setFieldValue(fields.access, state.access);
  setFieldValue(fields.slope, state.slope);
  setFieldValue(fields.obstacles, state.obstacles);
  setFieldValue(fields.cleanup, state.cleanup);
  setFieldValue(fields.greenWaste, state.greenWaste);
  setFieldValue(fields.travelMinutes, state.travelMinutes);
  setFieldValue(fields.setupMinutes, state.setupMinutes);
  setFieldValue(fields.notes, state.notes);
  setFieldValue(fields.hourlyRate, state.hourlyRate);
  setFieldValue(fields.minimumCharge, state.minimumCharge);
  setFieldValue(fields.wasteFee, state.wasteFee);
  setFieldValue(fields.margin, state.margin);

  zoneList.replaceChildren();
  const zones = Array.isArray(state.zones) && state.zones.length ? state.zones : [
    { name: "Front lawn", length: 10, width: 6, edging: 18 },
    { name: "Back lawn", length: 12, width: 8, edging: 24 }
  ];
  zones.forEach((zone) => createZone(zone));
  calculate();
}

function difficultyMultiplier() {
  const base =
    factors.grassHeight[fields.grassHeight.value] *
    factors.access[fields.access.value] *
    factors.slope[fields.slope.value] *
    factors.obstacles[fields.obstacles.value] *
    factors.cleanup[fields.cleanup.value];
  return base + factors.urgency[fields.urgency.value];
}

function renderBreakdown(items, container = priceBreakdown) {
  container.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = container === priceBreakdown ? "breakdown-row" : "print-line";
    const label = document.createElement("span");
    const value = document.createElement("strong");
    label.textContent = item.label;
    value.textContent = item.value;
    row.append(label, value);
    return row;
  }));
}

function calculate() {
  const formState = getFormState();
  const zones = getZones();
  const area = zones.reduce((sum, zone) => sum + zone.area, 0);
  const edging = zones.reduce((sum, zone) => sum + zone.edging, 0);
  const difficulty = difficultyMultiplier();

  const mowingMinutes = (area / 85) * 10;
  const edgingMinutes = (edging / 18) * 10;
  const cleanupMinutes = Math.max(8, area / 35) * factors.cleanup[fields.cleanup.value];
  const travelSetup = number(fields.travelMinutes.value) + number(fields.setupMinutes.value);
  const jobMinutes = (mowingMinutes + edgingMinutes + cleanupMinutes) * difficulty + travelSetup;

  const hourlyRate = number(fields.hourlyRate.value, 85);
  const minimumCharge = number(fields.minimumCharge.value, 80);
  const greenWasteFee = number(fields.wasteFee.value, 25) * wasteFees[fields.greenWaste.value];
  const margin = number(fields.margin.value, 15) / 100;
  const labor = (jobMinutes / 60) * hourlyRate;
  const subtotal = Math.max(minimumCharge, labor + greenWasteFee);
  const marginAmount = subtotal * margin;
  const price = subtotal + marginAmount;
  const roundedPrice = Math.ceil(price / 5) * 5;
  const low = Math.max(minimumCharge, Math.round((roundedPrice * 0.9) / 5) * 5);
  const high = Math.round((roundedPrice * 1.15) / 5) * 5;

  results.price.textContent = money(roundedPrice);
  results.range.textContent = `${money(low)} - ${money(high)} recommended range`;
  results.time.textContent = minutesLabel(jobMinutes);
  results.area.textContent = squareMetresLabel(area);
  results.edging.textContent = metresLabel(edging);
  results.difficulty.textContent = `${difficulty.toFixed(2)}x`;

  const noteLines = [
    `${minutesLabel(mowingMinutes)} mowing, ${minutesLabel(edgingMinutes)} edging, ${minutesLabel(cleanupMinutes)} cleanup before difficulty.`,
    `${minutesLabel(travelSetup)} allowed for travel and setup.`,
    greenWasteFee ? `${money(greenWasteFee)} green waste fee included before margin.` : "No green waste fee included.",
    fields.notes.value.trim() ? `Note: ${fields.notes.value.trim()}` : "Add notes for access, wet grass, locked gates, or customer requests."
  ];
  results.notes.replaceChildren(...noteLines.map((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    return p;
  }));

  const breakdown = [
    { label: "Mowing time", value: minutesLabel(mowingMinutes) },
    { label: "Edging time", value: minutesLabel(edgingMinutes) },
    { label: "Cleanup time", value: minutesLabel(cleanupMinutes) },
    { label: "Travel/setup", value: minutesLabel(travelSetup) },
    { label: "Difficulty multiplier", value: `${difficulty.toFixed(2)}x` },
    { label: "Labour", value: money(labor) },
    { label: "Green waste", value: money(greenWasteFee) },
    { label: "Minimum charge", value: money(minimumCharge) },
    { label: "Margin", value: money(marginAmount) },
    { label: "Suggested quote", value: money(roundedPrice) }
  ];
  renderBreakdown(breakdown);

  saveSettings();
  currentQuote = {
    customerName: fields.customerName.value.trim(),
    customerPhone: fields.customerPhone.value.trim(),
    customerEmail: fields.customerEmail.value.trim(),
    address: fields.address.value.trim(),
    jobType: fields.jobType.value,
    price: roundedPrice,
    low,
    high,
    minutes: Math.round(jobMinutes),
    area: Math.round(area),
    edging: Math.round(edging),
    difficulty: Number(difficulty.toFixed(2)),
    zones,
    notes: noteLines,
    breakdown,
    formState,
    createdAt: new Date().toISOString()
  };
  updatePrintSheet(currentQuote);
  return currentQuote;
}

function updatePrintSheet(quote) {
  document.querySelector("#print-price").textContent = money(quote.price);
  document.querySelector("#print-customer").textContent = quote.customerName || "Customer not set";
  document.querySelector("#print-phone").textContent = quote.customerPhone || quote.phone || quote.mobile || "Phone/mobile not set";
  document.querySelector("#print-email").textContent = quote.customerEmail || quote.email || "Email not set";
  document.querySelector("#print-address").textContent = quote.address || "Address not set";
  document.querySelector("#print-summary").textContent = `${quote.jobType} · ${minutesLabel(quote.minutes)} estimated · ${quote.area} m² lawn · ${quote.edging} m edging`;
  document.querySelector("#print-range").textContent = `${money(quote.low)} - ${money(quote.high)} recommended range`;
  renderBreakdown([
    { label: "Lawn area", value: squareMetresLabel(quote.area) },
    { label: "Edging", value: metresLabel(quote.edging) },
    { label: "Estimated time", value: minutesLabel(quote.minutes) },
    { label: "Difficulty", value: `${Number(quote.difficulty || 0).toFixed(2)}x` }
  ], document.querySelector("#print-measurements"));
  renderBreakdown(quote.breakdown || [
    { label: "Suggested quote", value: money(quote.price) }
  ], document.querySelector("#print-breakdown"));
  const notes = Array.isArray(quote.notes) && quote.notes.length ? quote.notes : ["No notes saved"];
  renderBreakdown(notes.map((note, index) => ({ label: `Note ${index + 1}`, value: note })), document.querySelector("#print-notes"));
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function distanceMetres(a, b) {
  const radius = 6371008.8;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function polygonAreaSquareMetres(points) {
  if (points.length < 3) return 0;
  const radius = 6378137;
  const originLat = toRadians(points.reduce((sum, point) => sum + point.lat, 0) / points.length);
  const projected = points.map((point) => ({
    x: radius * toRadians(point.lng) * Math.cos(originLat),
    y: radius * toRadians(point.lat)
  }));

  const area = projected.reduce((sum, point, index) => {
    const next = projected[(index + 1) % projected.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(area / 2);
}

function polygonPerimeterMetres(points) {
  if (points.length < 2) return 0;
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + distanceMetres(point, next);
  }, 0);
}

function updateMapMeasurement() {
  const area = polygonAreaSquareMetres(mapState.points);
  const edging = polygonPerimeterMetres(mapState.points);
  mapState.lastMeasurement = { area, edging };
  document.querySelector("#map-area").textContent = squareMetresLabel(area);
  document.querySelector("#map-edging").textContent = metresLabel(edging);

  const count = mapState.points.length;
  if (count < 3) {
    mapStatus.textContent = `${count} point${count === 1 ? "" : "s"} placed. Add at least 3 points around the lawn edge.`;
  } else {
    mapStatus.textContent = `${squareMetresLabel(area)} selected. Apply it to ${zoneDisplayName(mapState.targetZone)} when ready.`;
  }
}

function redrawPolygon() {
  if (!mapState.map) return;
  for (const marker of mapState.markers) marker.remove();
  mapState.markers = mapState.points.map((point, index) => window.L.marker(point, {
    title: `Point ${index + 1}`,
    keyboard: false
  }).addTo(mapState.map));

  if (mapState.polygon) mapState.polygon.remove();
  if (mapState.edgeLine) mapState.edgeLine.remove();

  if (mapState.points.length >= 3) {
    mapState.polygon = window.L.polygon(mapState.points, {
      color: "#1f7a4f",
      fillColor: "#1f7a4f",
      fillOpacity: 0.24,
      weight: 3
    }).addTo(mapState.map);
  } else if (mapState.points.length >= 2) {
    mapState.edgeLine = window.L.polyline(mapState.points, {
      color: "#1f7a4f",
      weight: 3
    }).addTo(mapState.map);
  }

  updateMapMeasurement();
}

function clearPolygon() {
  mapState.points = [];
  redrawPolygon();
}

function initMap() {
  if (mapState.map || !window.L) return;
  mapState.map = window.L.map("lawn-map", {
    center: [-33.8688, 151.2093],
    zoom: 18,
    zoomControl: true
  });

  const streetMap = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
  const satellite = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 20,
    attribution: "Tiles &copy; Esri"
  });
  mapState.cadastreOverlay = window.L.imageOverlay("", [[0, 0], [0, 0]], {
    opacity: 0.88,
    interactive: false,
    zIndex: 430
  });
  mapState.addressOverlay = window.L.imageOverlay("", [[0, 0], [0, 0]], {
    opacity: 0.95,
    interactive: false,
    zIndex: 440
  });
  streetMap.addTo(mapState.map);
  mapState.baseLayers = { street: streetMap, satellite };
  mapState.map.attributionControl.addAttribution('Cadastre &copy; <a href="https://data.nsw.gov.au/data/dataset/spatial-services-nsw-cadastre">NSW Spatial Services</a>');
  mapState.map.attributionControl.addAttribution('Address labels &copy; <a href="https://maps.six.nsw.gov.au/arcgis/rest/services/sixmaps/PropertyAddress/MapServer">SIX Maps PropertyAddress</a>');
  mapState.cadastreOverlay.addTo(mapState.map);
  mapState.addressOverlay.addTo(mapState.map);

  mapState.map.on("moveend zoomend resize", updateMapServiceOverlays);

  mapState.map.on("click", (event) => {
    mapState.points.push({ lat: event.latlng.lat, lng: event.latlng.lng });
    redrawPolygon();
  });
  updateMapServiceOverlays();
}

function mapExportUrl(baseUrl, layers) {
  const bounds = mapState.map.getBounds();
  const sw = mapState.map.options.crs.project(bounds.getSouthWest());
  const ne = mapState.map.options.crs.project(bounds.getNorthEast());
  const size = mapState.map.getSize();
  const url = new URL(baseUrl);
  url.searchParams.set("f", "image");
  url.searchParams.set("format", "png32");
  url.searchParams.set("transparent", "true");
  url.searchParams.set("bboxSR", "3857");
  url.searchParams.set("imageSR", "3857");
  url.searchParams.set("bbox", `${sw.x},${sw.y},${ne.x},${ne.y}`);
  url.searchParams.set("size", `${Math.max(256, size.x)},${Math.max(256, size.y)}`);
  url.searchParams.set("layers", layers);
  return url.toString();
}

function cadastreExportUrl() {
  const layerIds = [];
  if (showLotLabels.checked) layerIds.push("3");
  if (showBoundaries.checked) layerIds.push("9");
  return mapExportUrl(CADASTRE_EXPORT_URL, layerIds.length ? `show:${layerIds.join(",")}` : "hide:3,9");
}

function addressExportUrl() {
  return mapExportUrl(PROPERTY_ADDRESS_EXPORT_URL, "show:0");
}

function updateCadastreOverlay() {
  if (!mapState.map || !mapState.cadastreOverlay) return;
  const shouldShowCadastre = showBoundaries.checked || showLotLabels.checked;
  if (!shouldShowCadastre) {
    if (mapState.map.hasLayer(mapState.cadastreOverlay)) mapState.cadastreOverlay.remove();
    return;
  }
  if (!mapState.map.hasLayer(mapState.cadastreOverlay)) mapState.cadastreOverlay.addTo(mapState.map);
  mapState.cadastreOverlay.setBounds(mapState.map.getBounds());
  mapState.cadastreOverlay.setUrl(cadastreExportUrl());
}

function updateAddressOverlay() {
  if (!mapState.map || !mapState.addressOverlay) return;
  if (!showAddressLabels.checked) {
    if (mapState.map.hasLayer(mapState.addressOverlay)) mapState.addressOverlay.remove();
    return;
  }
  if (!mapState.map.hasLayer(mapState.addressOverlay)) mapState.addressOverlay.addTo(mapState.map);
  mapState.addressOverlay.setBounds(mapState.map.getBounds());
  mapState.addressOverlay.setUrl(addressExportUrl());
}

function updateMapServiceOverlays() {
  updateCadastreOverlay();
  updateAddressOverlay();
}

function switchBaseLayer(value) {
  if (!mapState.map || !mapState.baseLayers) return;
  for (const layer of Object.values(mapState.baseLayers)) {
    if (mapState.map.hasLayer(layer)) layer.remove();
  }
  mapState.baseLayers[value]?.addTo(mapState.map);
  updateMapServiceOverlays();
}

function openMap(targetZone = zoneList.querySelector(".zone-row")) {
  mapState.targetZone = targetZone;
  if (!window.L) {
    mapStatus.textContent = "Map library did not load. Check internet access or use manual dimensions.";
    return;
  }
  mapDialog.showModal();
  initMap();
  clearPolygon();
  mapStatus.textContent = `Click around ${zoneDisplayName(targetZone)} to outline the lawn edge.`;
  setTimeout(() => mapState.map.invalidateSize(), 80);
}

function applyPolygonToQuote() {
  if (!mapState.targetZone || mapState.points.length < 3) {
    mapStatus.textContent = "Add at least 3 points before applying the measurement.";
    return;
  }

  const area = Math.round(mapState.lastMeasurement.area);
  const edging = Math.round(mapState.lastMeasurement.edging);
  const side = Math.sqrt(area);
  mapState.targetZone.dataset.mappedArea = String(area);
  mapState.targetZone.querySelector(".zone-length").value = side.toFixed(1);
  mapState.targetZone.querySelector(".zone-width").value = side.toFixed(1);
  mapState.targetZone.querySelector(".zone-edging").value = edging;
  if (!mapState.targetZone.querySelector(".zone-name").value.trim()) {
    mapState.targetZone.querySelector(".zone-name").value = "Mapped lawn";
  }

  calculate();
  mapDialog.close();
}

async function searchMapLocation() {
  const query = document.querySelector("#map-search-input").value.trim() || fields.address.value.trim();
  if (!query || !mapState.map) return;
  mapStatus.textContent = "Searching OpenStreetMap location data...";
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", query);
    const response = await fetch(url, {
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error("Search failed");
    const [match] = await response.json();
    if (!match) {
      mapStatus.textContent = "No matching address found. Pan/zoom manually and try again.";
      return;
    }
    mapState.map.setView([Number(match.lat), Number(match.lon)], 19);
    mapStatus.textContent = "Location found. Click around the lawn edge to measure.";
  } catch {
    mapStatus.textContent = "Address search failed. Pan/zoom manually or use manual dimensions.";
  }
}

function selectAddress(match, input = fields.address, moveMap = false) {
  input.value = match.display_name;
  if (input !== fields.address) fields.address.value = match.display_name;
  if (moveMap && mapState.map) {
    mapState.map.setView([Number(match.lat), Number(match.lon)], 19);
    mapStatus.textContent = "Location selected. Turn on lot/property boundary overlay if needed, then outline the lawn.";
  }
}

function renderHistory() {
  const history = quoteHistory;
  if (!history.length) {
    historyList.innerHTML = `<p class="empty-state">No saved quotes yet.</p>`;
    return;
  }

  historyList.replaceChildren(...history.slice(0, 8).map((quote) => {
    const item = document.createElement("article");
    item.className = "history-item";
    const title = quote.customerName || quote.address || "Unnamed quote";
    const id = quote.id || quote.createdAt;
    const heading = document.createElement("strong");
    const headingText = document.createElement("span");
    const headingPrice = document.createElement("b");
    const meta = document.createElement("span");
    const actions = document.createElement("div");
    const viewButton = document.createElement("button");
    const editButton = document.createElement("button");
    const deleteButton = document.createElement("button");
    headingText.textContent = title;
    headingPrice.textContent = money(quote.price);
    meta.textContent = `${quote.area} m², ${quote.edging} m edging, ${minutesLabel(quote.minutes)}`;
    actions.className = "history-actions";
    viewButton.className = "secondary-button";
    editButton.className = "secondary-button";
    deleteButton.className = "danger-button";
    viewButton.type = "button";
    editButton.type = "button";
    deleteButton.type = "button";
    viewButton.textContent = "View";
    editButton.textContent = "Edit";
    deleteButton.textContent = "Delete";
    viewButton.addEventListener("click", () => viewSavedQuote(id));
    editButton.addEventListener("click", () => editSavedQuote(id));
    deleteButton.addEventListener("click", () => deleteSavedQuote(id));
    actions.append(viewButton, editButton, deleteButton);
    heading.append(headingText, headingPrice);
    item.append(heading, meta, actions);
    return item;
  }));
}

function setupQuoteStepper() {
  if (!quoteStepLinks.length || !("IntersectionObserver" in window)) return;
  const sections = quoteStepLinks
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible) return;
    const id = `#${visible.target.id}`;
    for (const link of quoteStepLinks) {
      const active = link.getAttribute("href") === id;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    }
  }, { rootMargin: "-20% 0px -55% 0px", threshold: [0.25, 0.55] });
  for (const section of sections) observer.observe(section);
}

async function saveQuote() {
  const quote = calculate();
  const history = quoteHistory.slice();
  quote.id = selectedHistoryId || quote.id || crypto.randomUUID();
  quote.updatedAt = new Date().toISOString();
  const existingIndex = history.findIndex((item) => (item.id || item.createdAt) === quote.id);
  if (existingIndex >= 0) {
    history[existingIndex] = quote;
  } else {
    history.unshift(quote);
  }
  selectedHistoryId = quote.id;
  quoteHistory = history.slice(0, 250);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quoteHistory));
  const saved = await saveQuoteJobs(quote);
  if (saved.ok) {
    quoteHistory = saved.quotes || quoteHistory;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(quoteHistory));
  }
  renderHistory();
}

function findSavedQuote(id) {
  return quoteHistory.find((quote) => (quote.id || quote.createdAt) === id);
}

function detailCard(label, value) {
  const card = document.createElement("div");
  card.className = "job-detail-card";
  const labelElement = document.createElement("span");
  const valueElement = document.createElement("strong");
  labelElement.textContent = label;
  valueElement.textContent = value || "--";
  card.append(labelElement, valueElement);
  return card;
}

function viewSavedQuote(id) {
  const quote = findSavedQuote(id);
  if (!quote) return;
  selectedHistoryId = id;
  updatePrintSheet(quote);
  jobDialogTitle.textContent = quote.customerName || quote.address || "Saved Quote";
  jobDialogMeta.textContent = `Saved ${new Date(quote.createdAt).toLocaleString()}${quote.updatedAt ? ` · Updated ${new Date(quote.updatedAt).toLocaleString()}` : ""}`;
  const grid = document.createElement("div");
  grid.className = "job-detail-grid";
  grid.append(
    detailCard("Price", money(quote.price)),
    detailCard("Range", `${money(quote.low)} - ${money(quote.high)}`),
    detailCard("Customer", quote.customerName || "Not set"),
    detailCard("Phone/mobile", quote.customerPhone || quote.phone || quote.mobile || "Not set"),
    detailCard("Email", quote.customerEmail || quote.email || "Not set"),
    detailCard("Address", quote.address || "Not set"),
    detailCard("Job type", quote.jobType),
    detailCard("Estimated time", minutesLabel(quote.minutes)),
    detailCard("Lawn area", squareMetresLabel(quote.area)),
    detailCard("Edging", metresLabel(quote.edging)),
    detailCard("Difficulty", `${Number(quote.difficulty || 0).toFixed(2)}x`),
    detailCard("Zones", `${quote.zones?.length || quote.formState?.zones?.length || 0}`)
  );
  const notes = document.createElement("div");
  notes.className = "job-detail-card";
  const notesLabel = document.createElement("span");
  const notesValue = document.createElement("strong");
  notesLabel.textContent = "Notes";
  notesValue.textContent = Array.isArray(quote.notes) ? quote.notes.join(" ") : "No notes saved";
  notes.append(notesLabel, notesValue);
  jobDialogContent.replaceChildren(grid, notes);
  jobDialog.showModal();
}

function editSavedQuote(id) {
  const quote = findSavedQuote(id);
  if (!quote) return;
  selectedHistoryId = id;
  const state = quote.formState || {
    customerName: quote.customerName,
    customerPhone: quote.customerPhone || quote.phone || quote.mobile,
    customerEmail: quote.customerEmail || quote.email,
    address: quote.address,
    jobType: quote.jobType,
    zones: quote.zones
  };
  loadFormState(state);
  jobDialog.close();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteSavedQuote(id) {
  const quote = findSavedQuote(id);
  if (!quote) return;
  const title = quote.customerName || quote.address || "this saved quote";
  if (!confirm(`Delete ${title}?`)) return;
  quoteHistory = quoteHistory.filter((item) => (item.id || item.createdAt) !== id);
  if (selectedHistoryId === id) selectedHistoryId = null;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quoteHistory));
  const deleted = await deleteQuoteJobs({ id });
  if (deleted.ok) quoteHistory = deleted.quotes || quoteHistory;
  renderHistory();
  if (jobDialog.open) jobDialog.close();
}

function printQuote() {
  calculate();
  window.print();
}

function resetForm() {
  form.reset();
  selectedHistoryId = null;
  zoneList.replaceChildren();
  createZone({ name: "Front lawn", length: 10, width: 6, edging: 18 });
  createZone({ name: "Back lawn", length: 12, width: 8, edging: 24 });
  photoGrid.replaceChildren();
  loadSettings();
  calculate();
}

photoInput.addEventListener("change", () => {
  photoGrid.replaceChildren();
  for (const file of [...photoInput.files].slice(0, 8)) {
    const image = document.createElement("img");
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
    photoGrid.append(image);
  }
});

document.querySelector("#add-zone").addEventListener("click", () => {
  createZone({ name: `Lawn area ${zoneList.children.length + 1}`, length: 8, width: 5, edging: 14 });
  calculate();
});

document.querySelector("#open-map").addEventListener("click", () => openMap());
document.querySelector("#close-map").addEventListener("click", () => mapDialog.close());
document.querySelector("#clear-polygon").addEventListener("click", clearPolygon);
document.querySelector("#undo-point").addEventListener("click", () => {
  mapState.points.pop();
  redrawPolygon();
});
document.querySelector("#apply-polygon").addEventListener("click", applyPolygonToQuote);
document.querySelector("#map-search-button").addEventListener("click", searchMapLocation);
document.querySelector("#map-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchMapLocation();
  }
});
for (const input of document.querySelectorAll('input[name="base-layer"]')) {
  input.addEventListener("change", () => switchBaseLayer(input.value));
}
showBoundaries.addEventListener("change", updateCadastreOverlay);
showAddressLabels.addEventListener("change", updateAddressOverlay);
showLotLabels.addEventListener("change", updateCadastreOverlay);
fields.address.addEventListener("input", () => {
  debounceAddressSearch(fields.address, addressSuggestions, (match) => selectAddress(match, fields.address, false));
});
document.querySelector("#map-search-input").addEventListener("input", (event) => {
  debounceAddressSearch(event.target, mapAddressSuggestions, (match) => selectAddress(match, event.target, true));
});
document.addEventListener("click", (event) => {
  if (!addressSuggestions.contains(event.target) && event.target !== fields.address) closeSuggestions(addressSuggestions);
  const mapSearchInput = document.querySelector("#map-search-input");
  if (!mapAddressSuggestions.contains(event.target) && event.target !== mapSearchInput) closeSuggestions(mapAddressSuggestions);
});

document.querySelector("#save-quote").addEventListener("click", () => {
  saveQuote().catch((error) => console.error(error));
});
document.querySelector("#print-quote").addEventListener("click", printQuote);
document.querySelector("#close-job-dialog").addEventListener("click", () => jobDialog.close());
document.querySelector("#edit-dialog-job").addEventListener("click", () => {
  if (selectedHistoryId) editSavedQuote(selectedHistoryId);
});
document.querySelector("#print-dialog-job").addEventListener("click", () => window.print());
document.querySelector("#reset-form").addEventListener("click", resetForm);
document.querySelector("#clear-history").addEventListener("click", async () => {
  quoteHistory = [];
  localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  await deleteQuoteJobs({ all: true });
  renderHistory();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  calculate();
});

form.addEventListener("input", calculate);
form.addEventListener("change", calculate);
window.addEventListener("resize", () => {
  detectDevice();
  if (mapState.map && mapDialog.open) {
    setTimeout(() => mapState.map.invalidateSize(), 80);
  }
});

detectDevice();
setupQuoteStepper();
loadSettings();
createZone({ name: "Front lawn", length: 10, width: 6, edging: 18 });
createZone({ name: "Back lawn", length: 12, width: 8, edging: 24 });
await refreshQuoteHistory();
renderHistory();
calculate();
