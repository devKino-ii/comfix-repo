/* Map rendering stays separate so a production map can replace this file. */
(() => {
  const center = [14.515134, 121.238086];
  const colors = { New: "#55617A", Verified: "#1B3FA0", "In progress": "#D98A00", Resolved: "#1D8A4F" };

  class ComfixMap {
    constructor(element, onPick = () => {}) {
      this.element = element;
      this.onPick = onPick;
      this.markers = [];
      this.markerByReport = new Map();
      if (window.google?.maps) this.createGoogleMap();
      else if (window.L) this.createLeafletMap();
      else this.showFallback();
    }

    createGoogleMap() {
      this.provider = "Google Maps";
      this.map = new google.maps.Map(this.element, { center: { lat: center[0], lng: center[1] }, zoom: 15, mapTypeControl: false, streetViewControl: false, fullscreenControl: false });
      this.map.addListener("click", event => this.onPick([event.latLng.lat(), event.latLng.lng()]));
    }

    createLeafletMap() {
      this.provider = "OpenStreetMap";
      this.map = L.map(this.element, { scrollWheelZoom: false }).setView(center, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(this.map);
      this.layer = L.layerGroup().addTo(this.map);
      this.map.on("click", event => this.onPick([event.latlng.lat, event.latlng.lng]));
    }

    showFallback() {
      this.provider = "Map unavailable";
      this.element.classList.add("map-fallback");
      this.element.innerHTML = '<span class="fallback-map-icon">⌖</span><b>Map tiles unavailable</b><small>You can still report without a pin.</small>';
    }

    focus(pin) {
      if (!this.map || !pin) return;
      if (this.provider === "Google Maps") { this.map.panTo({ lat: pin[0], lng: pin[1] }); this.map.setZoom(17); }
      else this.map.flyTo(pin, Math.max(this.map.getZoom(), 17), { duration: 1.1 });
    }

    reset() {
      if (!this.map) return;
      if (this.provider === "Google Maps") { this.map.panTo({ lat: center[0], lng: center[1] }); this.map.setZoom(15); }
      else this.map.flyTo(center, 15, { duration: 1 });
    }

    setPin(pin) {
      if (!this.map || !pin) return;
      if (this.provider === "Google Maps") {
        this.pinMarker?.setMap(null);
        this.pinMarker = new google.maps.Marker({ position: { lat: pin[0], lng: pin[1] }, map: this.map });
        this.map.panTo({ lat: pin[0], lng: pin[1] });
      } else {
        this.pinMarker?.remove();
        this.pinMarker = L.marker(pin).addTo(this.map);
        this.map.panTo(pin);
      }
    }

    clearPin() {
      if (!this.pinMarker) return;
      if (this.pinMarker.setMap) this.pinMarker.setMap(null);
      else this.pinMarker.remove();
      this.pinMarker = null;
    }

    setReports(reports, onSelect) {
      if (!this.map) return;
      if (this.provider === "OpenStreetMap") {
        this.map.closePopup();
        this.layer.clearLayers();
      } else this.markers.forEach(marker => marker.setMap(null));
      this.markers = [];
      this.markerByReport.clear();
      const pinnedReports = reports.filter(report => report.pin);
      pinnedReports.forEach(report => {
        const point = { lat: report.pin[0], lng: report.pin[1] };
        const color = colors[report.status] || colors.New;
        const reportKey = report.ids.join(",");
        const displayNumber = String(report.displayNumber ?? report.rank ?? "");
        if (this.provider === "Google Maps") {
          const marker = new google.maps.Marker({ position: point, map: this.map, label: { text: displayNumber, color: "#ffffff", fontSize: "11px", fontWeight: "700" }, title: report.title, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 13, fillColor: color, fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 } });
          const info = new google.maps.InfoWindow({ content: `<b>${escapeHtml(report.title)}</b><br>${escapeHtml(report.status)} · ${report.count} ${report.count === 1 ? "report" : "reports"}`, disableAutoPan: true });
          marker.addListener("click", () => {
            this.focusPoint(point);
            info.open({ map: this.map, anchor: marker });
            onSelect(report);
          });
          this.markers.push(marker);
          this.markerByReport.set(reportKey, { marker, info, point });
        } else {
          const icon = L.divIcon({ className: "report-map-icon", html: `<span style="--pin-color:${color}"><b>${escapeHtml(displayNumber)}</b></span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
          const popupHtml = `<b>${escapeHtml(report.title)}</b><br>${escapeHtml(report.status)} · ${report.count} ${report.count === 1 ? "report" : "reports"}`;
          const marker = L.marker([point.lat, point.lng], { icon }).on("click", () => onSelect(report));
          marker.addTo(this.layer);
          this.markers.push(marker);
          this.markerByReport.set(reportKey, { marker, point, popupHtml });
        }
      });
      const points = pinnedReports.map(report => report.pin);
      if (points.length > 1 && this.provider === "Google Maps") {
        const bounds = new google.maps.LatLngBounds();
        points.forEach(point => bounds.extend({ lat: point[0], lng: point[1] }));
        this.map.fitBounds(bounds, 48);
      } else if (points.length > 1 && this.provider === "OpenStreetMap") {
        this.map.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 16, animate: false });
      } else if (points.length === 1) {
        this.map.setView(points[0], 15);
      }
    }

    openReport(ids) {
      const entry = this.markerByReport.get(ids.join(","));
      if (!entry) return;
      this.focusPoint(entry.point);
      if (this.provider === "Google Maps") entry.info.open({ map: this.map, anchor: entry.marker });
      else entry.marker.bindPopup(entry.popupHtml, { autoPan: false }).openPopup();
    }

    focusPoint(point) {
      if (this.provider === "Google Maps") {
        this.map.setZoom(Math.max(this.map.getZoom() || 15, 16));
        this.map.panTo({ lat: point[0], lng: point[1] });
      } else {
        this.map.setView(point, Math.max(this.map.getZoom(), 16), { animate: false });
      }
    }

    resize() {
      if (this.provider === "OpenStreetMap" && this.map) setTimeout(() => this.map.invalidateSize(), 80);
      if (this.provider === "Google Maps" && this.map) google.maps.event.trigger(this.map, "resize");
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  window.ComfixMap = ComfixMap;
})();