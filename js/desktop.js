import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { ref, onValue, update, push, set, remove, get } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { SUPER_ADMIN, auth, db } from "./firebase-config.js";
import { generateS13Pdf } from "./s13-export.js";

const TIPE1_LABELS = {
  hamba_daerah: "Hamba Daerah",
  asisten_hamba_daerah: "Asisten Hamba Daerah",
  pengawas_dinas: "Pengawas Dinas",
  koordinator_badan_penatua: "Koordinator Badan Penatua"
};

const TIPE2_LABELS = {
  pengawas_kelompok: "Pengawas Kelompok",
  hamba_kelompok: "Hamba Kelompok",
  asisten_pengawas_kelompok: "Asisten Pengawas Kelompok"
};

const KDL_LIST = ["KDL Pemalang", "KDL Tegal Timur", "KDL Tegal Barat"];
const WELCOME_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzeUTW8a2VnDdj9qakYhyOiwZFtI3AakLMpLIV1KqBl9mGxtTRntneLUsJj7iWlxmCpbQ/exec";

let currentUser = null;
let currentProfile = { name: "Eden", role_daerah: "hamba_daerah", kdl: "", role_kdl: "" };
let hasTipe1Access = false;
let hasBulkAccess = false;
let canEditTerritory = false;
let allTerritories = {};
let allMembers = {};

// State Filter
let activeKdlFilter = "ALL";
let tagQuickFilter = "";
let statusQuickFilter = "";

let selectedId = null;
let editHistoryMode = false;
let editingMemberEmail = null;
let selectedBulkIds = new Set();

// 1. Mini-Map khusus kartu terpilih di editor utama
let singleMap = null;
let singlePolygon = null;

// 2. Full Overview Map (hanya di-render jika tab Peta Sebaran dibuka)
let overviewMap = null;
let overviewLayers = {};
let overviewRendered = false;

function emailToKey(email) {
  return email.toLowerCase().trim().replace(/\./g, ",");
}

function getLocalDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeMember(m) {
  let roleDaerah = m.role_daerah || "";
  if (!roleDaerah && m.role) {
    if (m.role === "hamba_daerah") roleDaerah = "hamba_daerah";
    else if (m.role === "asisten") roleDaerah = "asisten_hamba_daerah";
  }
  const kdl = KDL_LIST.includes(m.kdl) ? m.kdl : "";
  const roleKdl = kdl ? (m.role_kdl || "") : "";
  return { ...m, role_daerah: roleDaerah, kdl, role_kdl: roleKdl };
}

function isLeaderRoleKdl(roleKdl) {
  return roleKdl === "pengawas_kelompok" || roleKdl === "hamba_kelompok";
}

function getKdlLeader(kdl, excludeEmail = "") {
  if (!kdl) return null;
  const targetEmail = excludeEmail.toLowerCase().trim();
  for (const raw of Object.values(allMembers)) {
    const m = normalizeMember(raw);
    if (m.email.toLowerCase().trim() === targetEmail) continue;
    if (m.kdl === kdl && isLeaderRoleKdl(m.role_kdl)) return m;
  }
  return null;
}

function cleanTerritoryName(t) {
  return String(t.nama ?? "").trim() || `Daerah ${t.nomor || ""}`;
}

function formatShortKdl(kdl) {
  return (kdl || "Belum diatur").replace(/^KDL\s+/i, "");
}

function getInitials(name) {
  const clean = (name || "?").trim();
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

function formatMemberHeadline(m) {
  const roles = [];
  if (TIPE1_LABELS[m.role_daerah]) roles.push(TIPE1_LABELS[m.role_daerah]);
  if (m.kdl && TIPE2_LABELS[m.role_kdl]) roles.push(TIPE2_LABELS[m.role_kdl]);
  const roleStr = roles.join(" | ");
  if (roleStr && m.kdl) return `${roleStr} • ${formatShortKdl(m.kdl)}`;
  if (roleStr) return roleStr;
  if (m.kdl) return `Anggota • ${formatShortKdl(m.kdl)}`;
  return "Belum diatur";
}

function formatIndoTimestamp(isoStr) {
  if (!isoStr) return "-";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).replace(".", ":");
}

function isMyTerritory(t) {
  if (hasTipe1Access) return true;
  return Boolean(currentProfile.kdl) && (t.kdl || "") === currentProfile.kdl;
}

function addThreeMonths(dateStr) {
  if (!dateStr) return "";
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1 + 3, day);
  if (d.getDate() !== day) d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isAuditDue(t) {
  if (!t.pemegang || !t.jatuh_tempo_audit) return false;
  return t.jatuh_tempo_audit <= getLocalDateStr(0);
}

function isWorkedTerritory(t) {
  const hasActiveHolder = Boolean(t.pemegang && t.pemegang.trim() !== "");
  const hasHistory = Boolean(t.riwayat && Object.keys(t.riwayat).length > 0);
  return hasActiveHolder || hasHistory;
}

function sortByTerritoryNumber(a, b) {
  const numA = parseInt(a.nomor, 10);
  const numB = parseInt(b.nomor, 10);
  if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
  return String(a.nomor ?? "").localeCompare(String(b.nomor ?? ""), "id", { numeric: true });
}

// AUTH & STARTUP
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  const userEmail = user.email.toLowerCase();
  const userKey = emailToKey(userEmail);

  const snap = await get(ref(db, `users/${userKey}`));
  if (!snap.exists()) {
    if (userEmail === SUPER_ADMIN) {
      currentProfile = { email: userEmail, name: "Eden", role_daerah: "hamba_daerah", kdl: "", role_kdl: "" };
      await set(ref(db, `users/${userKey}`), currentProfile);
    } else {
      alert("Maaf, email Anda (" + user.email + ") belum terdaftar. Hubungi Hamba Daerah.");
      await signOut(auth);
      window.location.href = "index.html";
      return;
    }
  } else {
    currentProfile = normalizeMember(snap.val());
  }

  hasTipe1Access = (userEmail === SUPER_ADMIN || Boolean(TIPE1_LABELS[currentProfile.role_daerah]));
  hasBulkAccess = (
    userEmail === SUPER_ADMIN ||
    currentProfile.role_daerah === "hamba_daerah" ||
    currentProfile.role_daerah === "asisten_hamba_daerah"
  );
  const hasKdlEditRole = Boolean(currentProfile.kdl && TIPE2_LABELS[currentProfile.role_kdl]);
  canEditTerritory = hasTipe1Access || hasKdlEditRole;

  if (!hasTipe1Access && !currentProfile.kdl) {
    alert("Akun Anda belum ditempatkan di KDL mana pun. Hubungi Hamba Daerah.");
    await signOut(auth);
    window.location.href = "index.html";
    return;
  }

  document.body.style.display = "flex";
  document.getElementById("greetingName").textContent = currentProfile.name || user.email.split("@")[0];

  const roleParts = [];
  if (TIPE1_LABELS[currentProfile.role_daerah]) roleParts.push(TIPE1_LABELS[currentProfile.role_daerah]);
  if (currentProfile.kdl && TIPE2_LABELS[currentProfile.role_kdl]) roleParts.push(TIPE2_LABELS[currentProfile.role_kdl]);
  document.getElementById("greetingSub").textContent = roleParts.join(" • ") || currentProfile.kdl || "Semua KDL";

  if (hasTipe1Access) {
    document.getElementById("dNavMembers").style.display = "inline-flex";
    document.getElementById("openS13ModalBtn").style.display = "inline-flex";
    listenS13Logs();
  } else {
    document.getElementById("kdlFilterWrap").style.display = "none";
    document.getElementById("fullMapKdlSelect").style.display = "none";
  }

  if (hasBulkAccess) {
    document.getElementById("dNavBulk").style.display = "inline-flex";
  }

  listenMembers();
  listenTerritories();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("filter") === "due") {
    window.setQuickStatus("DUE");
  }
});

function listenTerritories() {
  onValue(ref(db, "territories"), (snap) => {
    allTerritories = snap.val() || {};
    renderStats();
    renderNotifications();
    renderWorkspaceList();
    if (hasBulkAccess) renderBulkList();
    if (overviewRendered) renderFullOverviewMap(false);
    if (selectedId && allTerritories[selectedId]) {
      renderHistoryList(allTerritories[selectedId]);
    }
  });
}

function renderStats() {
  const mineList = Object.values(allTerritories).filter(t => isMyTerritory(t));
  const workingCount = mineList.filter(t => isWorkedTerritory(t)).length;
  const availCount = mineList.length - workingCount;
  const dueCount = mineList.filter(t => isAuditDue(t)).length;

  document.getElementById("ovTotal").textContent = mineList.length;
  document.getElementById("ovWork").textContent = workingCount;
  document.getElementById("ovAvail").textContent = availCount;
  document.getElementById("ovDue").textContent = dueCount;
}

function getVisibleTerritories() {
  const list = Object.values(allTerritories).filter(t => isMyTerritory(t));
  const search = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();

  return list
    .filter(t => {
      if (activeKdlFilter !== "ALL" && t.kdl !== activeKdlFilter) return false;
      if (tagQuickFilter === "UMUM" && (t.kategori || "Umum") !== "Umum") return false;
      if (tagQuickFilter === "DK" && !t.daerah_kelompok) return false;
      if (tagQuickFilter === "PW" && !t.kunjungan_pw) return false;

      const isWorking = Boolean(t.pemegang && t.pemegang.trim() !== "");
      const hasHistory = Boolean(t.riwayat && Object.keys(t.riwayat).length > 0);
      if (statusQuickFilter === "work" && !isWorking) return false;
      if (statusQuickFilter === "DUE" && !isAuditDue(t)) return false;
      if (statusQuickFilter === "done" && (isWorking || !hasHistory)) return false;
      if (statusQuickFilter === "avail" && (isWorking || hasHistory)) return false;

      if (search) {
        const hay = `${t.nomor} ${t.nama} ${t.pemegang} ${t.kdl || ''} ${t.kategori || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    })
    .sort(sortByTerritoryNumber);
}

function renderWorkspaceList() {
  const filtered = getVisibleTerritories();
  const container = document.getElementById("territoryList");
  const countLabel = document.getElementById("visibleCountLabel");
  const resetBtn = document.getElementById("resetFilterBtn");

  const hasFilter = activeKdlFilter !== "ALL" || tagQuickFilter !== "" || statusQuickFilter !== "" || (document.getElementById("searchInput")?.value.trim() !== "");
  if (resetBtn) resetBtn.style.display = hasFilter ? "inline" : "none";
  if (countLabel) countLabel.textContent = `Menampilkan ${filtered.length} peta`;

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 1.5rem; text-align: center; color: var(--muted); font-size: 0.82rem;">Tidak ada peta ditemukan.</div>`;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const due = isAuditDue(t);
    const isWorking = Boolean(t.pemegang && t.pemegang.trim() !== "");
    const hasHistory = Boolean(t.riwayat && Object.keys(t.riwayat).length > 0);

    let badge = `<span class="badge b-avail">Kosong</span>`;
    if (due) badge = `<span class="badge b-due">Audit</span>`;
    else if (isWorking) badge = `<span class="badge b-work">Aktif</span>`;
    else if (hasHistory) badge = `<span class="badge b-done">Selesai</span>`;

    const kdlLabel = formatShortKdl(t.kdl);
    let subText = `${kdlLabel} • ${t.kategori || "Umum"}`;
    if (isWorking) {
      subText = `${t.pemegang} • ${kdlLabel}`;
    } else if (hasHistory) {
      const entries = Object.values(t.riwayat);
      const last = entries[entries.length - 1];
      subText = `Terakhir: ${last.pemegang} • ${kdlLabel}`;
    }
    const isSel = t.id === selectedId ? "selected" : "";

    return `
      <div class="list-item ${due ? 'is-due' : ''} ${isSel}" id="row-${t.id}" onclick="selectTerritory('${t.id}')">
        <div class="item-left">
          <span class="item-num">#${t.nomor}</span>
          <div class="item-info">
            <div class="item-title-row">
              <div class="item-title">${cleanTerritoryName(t)}</div>
              ${t.kunjungan_pw ? `<span class="pw-tag">KPW</span>` : ""}
              ${t.daerah_kelompok ? `<span class="dk-tag">Kelompok</span>` : ""}
            </div>
            <div class="item-sub">${subText}</div>
          </div>
        </div>
        ${badge}
      </div>
    `;
  }).join("");
}

// BUKA DETAIL DI EDITOR UTAMA KANAN
window.selectTerritory = function(id) {
  selectedId = id;
  editHistoryMode = false;
  const t = allTerritories[id];
  if (!t) return;

  switchDesktopView("viewWorkspace");

  document.querySelectorAll(".d-territory-list .list-item").forEach(el => el.classList.remove("selected"));
  const rowEl = document.getElementById(`row-${id}`);
  if (rowEl) {
    rowEl.classList.add("selected");
    rowEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  document.getElementById("inspectorEmpty").style.display = "none";
  document.getElementById("inspectorContent").style.display = "block";

  document.getElementById("inspKdlBadge").textContent = t.kdl || "Belum diatur KDL";
  document.getElementById("mNama").textContent = `${t.nomor ? `#${t.nomor} — ` : ""}${cleanTerritoryName(t)}`;

  const inpPemegang = document.getElementById("fPemegang");
  const inpTglMulai = document.getElementById("fTglMulai");
  const inpCatatan = document.getElementById("fCatatan");

  inpPemegang.value = t.pemegang || "";
  inpTglMulai.value = t.tanggal_mulai || "";
  inpCatatan.value = t.catatan || "";

  document.getElementById("fNamaDaerah").value = t.nama || "";
  document.getElementById("fKategori").value = t.kategori || "Umum";
  document.getElementById("fKdlPeta").value = t.kdl || "";
  document.getElementById("fMyMapsUrl").value = t.mymaps_url || "";
  document.getElementById("fKunjunganPw").checked = Boolean(t.kunjungan_pw);
  document.getElementById("fDaerahKelompok").checked = Boolean(t.daerah_kelompok);

  document.getElementById("attrBody").style.display = "none";
  document.getElementById("attrChevron").style.transform = "rotate(0deg)";
  document.getElementById("finishConfirmBox").style.display = "none";

  inpPemegang.disabled = !canEditTerritory;
  inpTglMulai.disabled = !canEditTerritory;
  inpCatatan.disabled = !canEditTerritory;

  document.getElementById("attrPanel").style.display = canEditTerritory ? "block" : "none";
  document.getElementById("fKdlField").style.display = hasTipe1Access ? "block" : "none";
  document.getElementById("viewOnlyNotice").style.display = canEditTerritory ? "none" : "block";
  document.getElementById("saveBtn").style.display = canEditTerritory ? "inline-flex" : "none";
  document.getElementById("primaryActionRow").style.gridTemplateColumns = canEditTerritory ? "1fr 1fr" : "1fr";

  const hasHolder = t.pemegang && t.pemegang.trim() !== "";
  document.getElementById("holderActionRow").style.display = (canEditTerritory && hasHolder) ? "grid" : "none";

  renderHistoryList(t);

  // Render mini-map khusus 1 kartu ini
  setTimeout(() => {
    if (!singleMap) {
      singleMap = L.map("singleMapContainer").setView([-6.89, 109.38], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OSM" }).addTo(singleMap);
    }
    singleMap.invalidateSize();
    if (singlePolygon) singleMap.removeLayer(singlePolygon);
    if (t.koordinat && t.koordinat.length > 0) {
      singlePolygon = L.polygon(t.koordinat, { color: "#2563eb", fillOpacity: 0.25 }).addTo(singleMap);
      singleMap.fitBounds(singlePolygon.getBounds(), { padding: [20, 20] });
    }
  }, 80);
};

document.getElementById("closeInspectorBtn")?.addEventListener("click", () => {
  selectedId = null;
  document.getElementById("inspectorContent").style.display = "none";
  document.getElementById("inspectorEmpty").style.display = "flex";
  renderWorkspaceList();
});

// Tombol "Lihat di Peta Sebaran" dari dalam detail kartu
document.getElementById("jumpToFullMapBtn")?.addEventListener("click", () => {
  const targetId = selectedId;
  switchDesktopView("viewFullMap");
  if (targetId && overviewLayers[targetId] && overviewMap) {
    setTimeout(() => {
      overviewMap.flyToBounds(overviewLayers[targetId].getBounds(), { padding: [60, 60], maxZoom: 16 });
      overviewLayers[targetId].openTooltip();
    }, 150);
  }
});

// TAB 2: PETA SEBARAN KESELURUHAN (OPSIONAL)
function renderFullOverviewMap(fitBounds = true) {
  if (!overviewMap) {
    overviewMap = L.map("desktopOverviewMap").setView([-6.89, 109.25], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(overviewMap);
  }
  overviewMap.invalidateSize();

  const kdlFilter = document.getElementById("fullMapKdlSelect")?.value || "ALL";
  const visibleList = Object.values(allTerritories).filter(t => {
    if (!isMyTerritory(t)) return false;
    if (kdlFilter !== "ALL" && t.kdl !== kdlFilter) return false;
    return true;
  });

  Object.values(overviewLayers).forEach(layer => overviewMap.removeLayer(layer));
  overviewLayers = {};

  const boundsGroup = [];
  visibleList.forEach(t => {
    if (!t.koordinat || t.koordinat.length === 0) return;
    const due = isAuditDue(t);
    const isWorking = Boolean(t.pemegang && t.pemegang.trim() !== "");
    const hasHistory = Boolean(t.riwayat && Object.keys(t.riwayat).length > 0);
    let color = "#10b981"; // Kosong (Hijau)
    if (due) color = "#ef4444"; // Audit (Merah)
    else if (isWorking) color = "#2563eb"; // Aktif (Biru)
    else if (hasHistory) color = "#f59e0b"; // Pernah (Kuning/Amber)

    const poly = L.polygon(t.koordinat, {
      color, weight: 1.5, fillColor: color, fillOpacity: 0.2
    }).addTo(overviewMap);

    poly.bindTooltip(`<strong>#${t.nomor}</strong> — ${cleanTerritoryName(t)}${t.pemegang ? ` (${t.pemegang})` : ""}`, { sticky: true });
    poly.on("click", () => {
      selectTerritory(t.id);
    });
    overviewLayers[t.id] = poly;
    boundsGroup.push(poly);
  });

  if (fitBounds && boundsGroup.length > 0) {
    overviewMap.fitBounds(L.featureGroup(boundsGroup).getBounds(), { padding: [24, 24] });
  }
  overviewRendered = true;
}

document.getElementById("fullMapKdlSelect")?.addEventListener("change", () => renderFullOverviewMap(true));
document.getElementById("fitAllPolygonsBtn")?.addEventListener("click", () => {
  const layers = Object.values(overviewLayers);
  if (layers.length > 0 && overviewMap) {
    overviewMap.fitBounds(L.featureGroup(layers).getBounds(), { padding: [24, 24] });
  }
});

// FILTER EVENTS
document.querySelectorAll("#filterKdlGroup .dpill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#filterKdlGroup .dpill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeKdlFilter = btn.dataset.kdl;
    renderWorkspaceList();
  });
});

document.getElementById("filterTipeSelect")?.addEventListener("change", (e) => {
  tagQuickFilter = e.target.value;
  renderWorkspaceList();
});

document.getElementById("filterStatusSelect")?.addEventListener("change", (e) => {
  statusQuickFilter = e.target.value;
  renderWorkspaceList();
});

document.getElementById("searchInput")?.addEventListener("input", renderWorkspaceList);

window.setQuickStatus = function(statusVal) {
  statusQuickFilter = statusVal;
  const sel = document.getElementById("filterStatusSelect");
  if (sel) sel.value = statusVal;
  switchDesktopView("viewWorkspace");
  renderWorkspaceList();
};

document.getElementById("resetFilterBtn")?.addEventListener("click", () => {
  activeKdlFilter = "ALL";
  tagQuickFilter = "";
  statusQuickFilter = "";
  document.getElementById("searchInput").value = "";
  document.getElementById("filterTipeSelect").value = "";
  document.getElementById("filterStatusSelect").value = "";
  document.querySelectorAll("#filterKdlGroup .dpill").forEach(b => b.classList.toggle("active", b.dataset.kdl === "ALL"));
  renderWorkspaceList();
});

// SIMPAN, WA, AUDIT, SELESAI
document.getElementById("toggleAttrBtn")?.addEventListener("click", () => {
  const body = document.getElementById("attrBody");
  const chev = document.getElementById("attrChevron");
  const isOpen = body.style.display === "block";
  body.style.display = isOpen ? "none" : "block";
  chev.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
});

document.getElementById("saveBtn")?.addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const t = allTerritories[selectedId];
  const pemegang = document.getElementById("fPemegang").value.trim();
  const tglMulai = document.getElementById("fTglMulai").value;
  const isNewCycle = tglMulai !== t.tanggal_mulai || !t.jatuh_tempo_audit;
  let jatuhTempo = (pemegang && tglMulai) ? (isNewCycle ? addThreeMonths(tglMulai) : t.jatuh_tempo_audit) : "";

  const payload = {
    pemegang,
    status: pemegang ? "Sedang Dikerjakan" : "Tersedia",
    tanggal_mulai: tglMulai,
    jatuh_tempo_audit: jatuhTempo,
    catatan: document.getElementById("fCatatan").value.trim(),
    nama: document.getElementById("fNamaDaerah").value.trim() || t.nama || "",
    kategori: document.getElementById("fKategori").value,
    mymaps_url: document.getElementById("fMyMapsUrl").value.trim(),
    kunjungan_pw: document.getElementById("fKunjunganPw").checked,
    daerah_kelompok: document.getElementById("fDaerahKelompok").checked
  };
  if (!pemegang || isNewCycle) payload.audit_notified_at = "";
  if (hasTipe1Access) payload.kdl = document.getElementById("fKdlPeta").value;

  await update(ref(db, `territories/${selectedId}`), payload);
  selectTerritory(selectedId);
});

document.getElementById("shareWaBtn")?.addEventListener("click", () => {
  if (!selectedId) return;
  const t = allTerritories[selectedId];
  if (!t) return;

  const namaPeta = cleanTerritoryName(t);
  const pemegangVal = document.getElementById("fPemegang").value.trim();
  const tglMulaiVal = document.getElementById("fTglMulai").value;
  const catatanVal = document.getElementById("fCatatan").value.trim();
  const myMapsVal = document.getElementById("fMyMapsUrl").value.trim() || (t.mymaps_url || "").trim();

  let mapsLink = "";
  if (myMapsVal) {
    mapsLink = `🗺️ Peta My Maps: ${myMapsVal}`;
  } else if (t.koordinat && t.koordinat.length > 0) {
    const center = L.polygon(t.koordinat).getBounds().getCenter();
    mapsLink = `📍 Lokasi Maps: https://maps.google.com/?q=${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
  }

  const lines = [
    `*PETA DAERAH — ${namaPeta.toUpperCase()}*`,
    pemegangVal ? `• Pemegang: ${pemegangVal}` : `• Status: Tersedia`,
    tglMulaiVal ? `• Mulai: ${tglMulaiVal}` : null,
    catatanVal ? `• Catatan: ${catatanVal}` : null,
    mapsLink
  ].filter(Boolean);

  window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank");
});

document.getElementById("auditContinueBtn")?.addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const pemegang = document.getElementById("fPemegang").value.trim();
  if (!pemegang) return;
  const today = getLocalDateStr(0);

  await push(ref(db, `territories/${selectedId}/riwayat`), {
    pemegang,
    tanggal_mulai: document.getElementById("fTglMulai").value || today,
    keterangan: `Audit 3 Bln (${today}): Lanjut`,
    tanggal_kembali: today
  });
  await update(ref(db, `territories/${selectedId}`), {
    tanggal_mulai: today,
    jatuh_tempo_audit: addThreeMonths(today),
    audit_notified_at: ""
  });
  selectTerritory(selectedId);
});

document.getElementById("finishBtn")?.addEventListener("click", () => {
  if (!selectedId || !canEditTerritory) return;
  const tglInput = document.getElementById("fTglSelesai");
  tglInput.value = getLocalDateStr(0);
  tglInput.max = getLocalDateStr(0);
  document.getElementById("holderActionRow").style.display = "none";
  document.getElementById("finishConfirmBox").style.display = "block";
});

document.getElementById("setFinishYesterdayBtn")?.addEventListener("click", () => {
  document.getElementById("fTglSelesai").value = getLocalDateStr(-1);
});
document.getElementById("setFinishTodayBtn")?.addEventListener("click", () => {
  document.getElementById("fTglSelesai").value = getLocalDateStr(0);
});
document.getElementById("cancelFinishBtn")?.addEventListener("click", () => {
  document.getElementById("finishConfirmBox").style.display = "none";
  document.getElementById("holderActionRow").style.display = "grid";
});

document.getElementById("confirmFinishBtn")?.addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const pemegang = document.getElementById("fPemegang").value.trim();
  if (!pemegang) return;
  const tglSelesai = document.getElementById("fTglSelesai").value || getLocalDateStr(0);

  await push(ref(db, `territories/${selectedId}/riwayat`), {
    pemegang,
    tanggal_mulai: document.getElementById("fTglMulai").value || tglSelesai,
    keterangan: "Selesai & Dikembalikan",
    tanggal_kembali: tglSelesai
  });
  await update(ref(db, `territories/${selectedId}`), {
    pemegang: "", status: "Tersedia", tanggal_mulai: "",
    jatuh_tempo_audit: "", audit_notified_at: "", catatan: ""
  });
  document.getElementById("finishConfirmBox").style.display = "none";
  selectTerritory(selectedId);
});

// RIWAYAT PENGERJAAN
function renderHistoryList(t) {
  const histEl = document.getElementById("historyList");
  const toggleBtn = document.getElementById("toggleEditHistoryBtn");
  const summaryEl = document.getElementById("historySummaryText");
  const entries = t.riwayat ? Object.entries(t.riwayat).reverse() : [];

  if (entries.length === 0) {
    summaryEl.textContent = "Belum ada riwayat pengerjaan.";
    toggleBtn.style.display = "none";
    histEl.innerHTML = "";
    return;
  }

  summaryEl.textContent = `Riwayat Pengerjaan (${entries.length})`;
  toggleBtn.style.display = hasTipe1Access ? "inline-flex" : "none";
  toggleBtn.textContent = editHistoryMode ? "Selesai Kelola" : "Kelola Riwayat";

  histEl.innerHTML = entries.map(([histKey, r]) => `
    <div class="hist-item">
      <div style="min-width: 0; flex: 1;">
        <strong>${r.pemegang}</strong>
        <div style="color:var(--muted); font-size:0.7rem;">${r.keterangan || ''}</div>
      </div>
      <div style="text-align:right; font-size:0.7rem; color:var(--muted); flex-shrink: 0;">
        ${r.tanggal_mulai || '-'}<br>s/d ${r.tanggal_kembali || '-'}
      </div>
      ${editHistoryMode ? `
        <button type="button" class="btn-sm btn-logout" style="padding: 0.25rem 0.45rem; font-size: 0.7rem;" onclick="deleteHistoryItem('${histKey}', '${(r.pemegang || '').replace(/'/g, "\\'")}')">Hapus</button>
      ` : ''}
    </div>
  `).join("");
}

document.getElementById("toggleEditHistoryBtn")?.addEventListener("click", () => {
  if (!selectedId || !allTerritories[selectedId]) return;
  editHistoryMode = !editHistoryMode;
  renderHistoryList(allTerritories[selectedId]);
});

window.deleteHistoryItem = async function(histKey, pemegangName) {
  if (!selectedId || !hasTipe1Access) return;
  if (!confirm(`Hapus permanen catatan riwayat atas nama "${pemegangName}"?`)) return;
  await remove(ref(db, `territories/${selectedId}/riwayat/${histKey}`));
};

// NAVIGASI VIEW DESKTOP
window.switchDesktopView = function(viewId) {
  if (viewId === "viewMembers" && !hasTipe1Access) return;
  if (viewId === "viewBulk" && !hasBulkAccess) return;

  ["viewWorkspace", "viewFullMap", "viewMembers", "viewBulk"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === viewId ? (id === "viewWorkspace" ? "grid" : "block") : "none";
  });

  document.querySelectorAll(".d-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.view === viewId);
  });

  if (viewId === "viewFullMap") {
    setTimeout(() => renderFullOverviewMap(!overviewRendered), 80);
  }
  if (viewId === "viewWorkspace" && singleMap) {
    setTimeout(() => singleMap.invalidateSize(), 80);
  }
  if (viewId === "viewBulk") renderBulkList();
  updateBulkSelectionUI();
};

document.querySelectorAll(".d-tab").forEach(tab => {
  tab.addEventListener("click", () => switchDesktopView(tab.dataset.view));
});

// KELOLA ANGGOTA
function listenMembers() {
  onValue(ref(db, "users"), (snap) => {
    allMembers = snap.val() || {};
    renderMembers();
    refreshNewMemberRoleOptions();
  });
}

function renderMembers() {
  const listEl = document.getElementById("memberList");
  if (!listEl) return;
  const membersArr = Object.values(allMembers)
    .map(normalizeMember)
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, "id", { sensitivity: "base" }));

  listEl.innerHTML = membersArr.map(m => {
    const displayName = m.name || m.email.split("@")[0];
    return `
      <div class="member-row" onclick="openEditMemberModal('${m.email}')">
        <div class="member-avatar">${getInitials(displayName)}</div>
        <div class="member-info">
          <div class="member-name">${displayName}</div>
          <div class="member-headline">${formatMemberHeadline(m)}</div>
          <div class="member-email">${m.email}</div>
        </div>
        <svg class="ico ico-sm" style="color: var(--muted);" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `;
  }).join("");
}

function syncRoleKdlOptions(kdlSelectEl, roleKdlSelectEl, excludeEmail = "") {
  const chosenKdl = kdlSelectEl.value;
  roleKdlSelectEl.disabled = !chosenKdl;
  if (!chosenKdl) { roleKdlSelectEl.value = ""; return; }

  const leader = getKdlLeader(chosenKdl, excludeEmail);
  const optPengawas = roleKdlSelectEl.querySelector('option[value="pengawas_kelompok"]');
  const optHamba = roleKdlSelectEl.querySelector('option[value="hamba_kelompok"]');

  if (leader) {
    const info = ` (Sudah diisi ${leader.name || leader.email})`;
    optPengawas.disabled = true; optPengawas.textContent = `Pengawas Kelompok${info}`;
    optHamba.disabled = true; optHamba.textContent = `Hamba Kelompok${info}`;
    if (isLeaderRoleKdl(roleKdlSelectEl.value)) roleKdlSelectEl.value = "";
  } else {
    optPengawas.disabled = false; optPengawas.textContent = "Pengawas Kelompok";
    optHamba.disabled = false; optHamba.textContent = "Hamba Kelompok";
  }
}

function refreshNewMemberRoleOptions() {
  const kdlSel = document.getElementById("newMemberKdl");
  const roleKdlSel = document.getElementById("newMemberRoleKdl");
  if (kdlSel && roleKdlSel) syncRoleKdlOptions(kdlSel, roleKdlSel, "");
}

document.getElementById("newMemberKdl")?.addEventListener("change", refreshNewMemberRoleOptions);
document.getElementById("openAddMemberBtn")?.addEventListener("click", () => {
  document.getElementById("newMemberEmail").value = "";
  document.getElementById("newMemberName").value = "";
  document.getElementById("newMemberRoleDaerah").value = "";
  document.getElementById("newMemberKdl").value = "";
  document.getElementById("newMemberRoleKdl").value = "";
  refreshNewMemberRoleOptions();
  document.getElementById("addMemberModal").style.display = "flex";
});
document.getElementById("closeAddMemberBtn")?.addEventListener("click", () => {
  document.getElementById("addMemberModal").style.display = "none";
});

document.getElementById("addMemberBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("newMemberEmail").value.trim().toLowerCase();
  const name = document.getElementById("newMemberName").value.trim();
  const roleDaerah = document.getElementById("newMemberRoleDaerah").value;
  const kdl = document.getElementById("newMemberKdl").value;
  const roleKdl = kdl ? document.getElementById("newMemberRoleKdl").value : "";

  if (!email) return alert("Masukkan alamat email anggota.");
  if (!roleDaerah && !kdl) return alert("Pilih minimal Peran Daerah (Tipe 1) atau Penempatan KDL (Tipe 2).");
  if (kdl && isLeaderRoleKdl(roleKdl)) {
    const conflict = getKdlLeader(kdl, email);
    if (conflict) return alert(`${kdl} sudah memiliki ${TIPE2_LABELS[conflict.role_kdl]} (${conflict.name || conflict.email}).`);
  }

  const finalName = name || email.split("@")[0];
  const newMemberData = { email, name: finalName, role_daerah: roleDaerah, kdl, role_kdl: roleKdl };
  await set(ref(db, `users/${emailToKey(email)}`), newMemberData);
  document.getElementById("addMemberModal").style.display = "none";

  if (WELCOME_WEBHOOK_URL && WELCOME_WEBHOOK_URL.startsWith("https://")) {
    fetch(WELCOME_WEBHOOK_URL, {
      method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "welcome_member", email, name: finalName, role_summary: formatMemberHeadline(normalizeMember(newMemberData)) })
    }).catch(() => {});
  }
});

window.openEditMemberModal = function(email) {
  if (!hasTipe1Access) return;
  const raw = allMembers[emailToKey(email)];
  if (!raw) return;
  const m = normalizeMember(raw);
  editingMemberEmail = m.email;
  const isSuper = m.email.toLowerCase() === SUPER_ADMIN;

  document.getElementById("editMemberEmailSub").textContent = m.email;
  document.getElementById("editMemberName").value = m.name || "";
  const roleDaerahSel = document.getElementById("editMemberRoleDaerah");
  roleDaerahSel.value = m.role_daerah || "";
  roleDaerahSel.disabled = isSuper;

  const kdlSel = document.getElementById("editMemberKdl");
  const roleKdlSel = document.getElementById("editMemberRoleKdl");
  kdlSel.value = m.kdl || "";
  roleKdlSel.value = m.role_kdl || "";
  syncRoleKdlOptions(kdlSel, roleKdlSel, m.email);

  document.getElementById("deleteEditMemberBtn").style.display = isSuper ? "none" : "block";
  document.getElementById("editMemberModal").style.display = "flex";
};

document.getElementById("editMemberKdl")?.addEventListener("change", () => {
  syncRoleKdlOptions(document.getElementById("editMemberKdl"), document.getElementById("editMemberRoleKdl"), editingMemberEmail || "");
});
document.getElementById("closeEditMemberBtn")?.addEventListener("click", () => {
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});
document.getElementById("saveEditMemberBtn")?.addEventListener("click", async () => {
  if (!hasTipe1Access || !editingMemberEmail) return;
  const isSuper = editingMemberEmail.toLowerCase() === SUPER_ADMIN;
  const name = document.getElementById("editMemberName").value.trim() || editingMemberEmail.split("@")[0];
  const roleDaerah = isSuper ? "hamba_daerah" : document.getElementById("editMemberRoleDaerah").value;
  const kdl = document.getElementById("editMemberKdl").value;
  const roleKdl = kdl ? document.getElementById("editMemberRoleKdl").value : "";

  if (!roleDaerah && !kdl) return alert("Pilih minimal Peran Daerah (Tipe 1) atau Penempatan KDL (Tipe 2).");
  await update(ref(db, `users/${emailToKey(editingMemberEmail)}`), { name, role_daerah: roleDaerah, kdl, role_kdl: roleKdl, role: null });
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});
document.getElementById("deleteEditMemberBtn")?.addEventListener("click", async () => {
  if (!hasTipe1Access || !editingMemberEmail || editingMemberEmail.toLowerCase() === SUPER_ADMIN) return;
  if (!confirm(`Hapus akses untuk ${editingMemberEmail}?`)) return;
  await remove(ref(db, `users/${emailToKey(editingMemberEmail)}`));
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});

// BULK EDITOR
function getBulkFilteredTerritories() {
  const kdlFilter = document.getElementById("bulkFilterKdl")?.value || "ALL";
  const search = (document.getElementById("bulkSearchInput")?.value || "").toLowerCase().trim();
  return Object.values(allTerritories)
    .filter(t => {
      if (kdlFilter === "UNASSIGNED" && t.kdl) return false;
      if (kdlFilter.startsWith("KDL ") && t.kdl !== kdlFilter) return false;
      if (search && !`${t.nomor} ${t.nama} ${t.kdl || ''}`.toLowerCase().includes(search)) return false;
      return true;
    })
    .sort(sortByTerritoryNumber);
}

function updateBulkSelectionUI() {
  const count = selectedBulkIds.size;
  document.getElementById("selectedCount").textContent = count;
  document.getElementById("bulkSelectedBadge").textContent = `${count} dipilih`;
  const isBulkActive = document.getElementById("viewBulk")?.style.display === "block";
  document.getElementById("bulkActionBar").style.display = (isBulkActive && count > 0) ? "flex" : "none";
}

function renderBulkList() {
  if (!hasBulkAccess) return;
  const container = document.getElementById("bulkTerritoryList");
  const filtered = getBulkFilteredTerritories();
  container.innerHTML = filtered.map(t => {
    const checked = selectedBulkIds.has(t.id) ? "checked" : "";
    return `
      <div class="list-item" onclick="toggleBulkItem('${t.id}')">
        <input type="checkbox" class="bulk-check" ${checked} onclick="event.stopPropagation(); toggleBulkItem('${t.id}')">
        <div class="item-left">
          <span class="item-num">#${t.nomor}</span>
          <div class="item-info">
            <div class="item-title-row">
              <div class="item-title">${cleanTerritoryName(t)}</div>
              ${t.kunjungan_pw ? `<span class="pw-tag">KPW</span>` : ""}
              ${t.daerah_kelompok ? `<span class="dk-tag">Kelompok</span>` : ""}
            </div>
            <div class="item-sub">${formatShortKdl(t.kdl)} • ${t.kategori || "Umum"}${t.pemegang ? ` • ${t.pemegang}` : ''}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
  updateBulkSelectionUI();
}

window.toggleBulkItem = function(id) {
  if (selectedBulkIds.has(id)) selectedBulkIds.delete(id);
  else selectedBulkIds.add(id);
  renderBulkList();
};

document.getElementById("selectRangeBtn")?.addEventListener("click", () => {
  const raw = document.getElementById("bulkRangeInput").value.trim();
  if (!raw) return;
  const targetNums = new Set();
  raw.split(",").forEach(part => {
    const clean = part.trim();
    if (clean.includes("-")) {
      const [s, e] = clean.split("-").map(Number);
      if (!isNaN(s) && !isNaN(e) && s <= e) for (let i = s; i <= e; i++) targetNums.add(i);
    } else {
      const n = parseInt(clean, 10);
      if (!isNaN(n)) targetNums.add(n);
    }
  });
  Object.values(allTerritories).forEach(t => {
    if (targetNums.has(parseInt(t.nomor, 10))) selectedBulkIds.add(t.id);
  });
  renderBulkList();
});

document.getElementById("bulkSelectAllBtn")?.addEventListener("click", () => {
  getBulkFilteredTerritories().forEach(t => selectedBulkIds.add(t.id));
  renderBulkList();
});
document.getElementById("bulkClearAllBtn")?.addEventListener("click", () => {
  selectedBulkIds.clear();
  document.getElementById("bulkRangeInput").value = "";
  renderBulkList();
});
document.getElementById("bulkFilterKdl")?.addEventListener("change", renderBulkList);
document.getElementById("bulkSearchInput")?.addEventListener("input", renderBulkList);

document.getElementById("applyBulkBtn")?.addEventListener("click", async () => {
  if (!hasBulkAccess || selectedBulkIds.size === 0) return;
  const [actionType, actionVal] = document.getElementById("bulkTargetAction").value.split(":");
  if (actionType === "reset" && !confirm(`Reset ${selectedBulkIds.size} peta terpilih menjadi Kosong?`)) return;

  const updates = {};
  selectedBulkIds.forEach(id => {
    if (actionType === "kdl") updates[`territories/${id}/kdl`] = actionVal;
    else if (actionType === "pw") updates[`territories/${id}/kunjungan_pw`] = (actionVal === "true");
    else if (actionType === "dk") updates[`territories/${id}/daerah_kelompok`] = (actionVal === "true");
    else if (actionType === "cat") updates[`territories/${id}/kategori`] = actionVal;
    else if (actionType === "reset") {
      updates[`territories/${id}/pemegang`] = "";
      updates[`territories/${id}/status`] = "Tersedia";
      updates[`territories/${id}/tanggal_mulai`] = "";
      updates[`territories/${id}/jatuh_tempo_audit`] = "";
      updates[`territories/${id}/audit_notified_at`] = "";
      updates[`territories/${id}/catatan`] = "";
    }
  });
  await update(ref(db), updates);
  selectedBulkIds.clear();
  renderBulkList();
});

// S-13 & NOTIFIKASI
function listenS13Logs() {
  onValue(ref(db, "s13_logs"), (snap) => {
    const logs = Object.values(snap.val() || {}).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    const listEl = document.getElementById("s13LogList");
    if (!listEl) return;
    if (logs.length === 0) {
      listEl.innerHTML = `<div style="font-size: 0.75rem; color: var(--muted);">Belum ada riwayat generate S-13.</div>`;
      return;
    }
    listEl.innerHTML = logs.slice(0, 5).map(item => `
      <div class="hist-item">
        <div><strong>${item.nama}</strong> <span class="role-tag">${item.role_label}</span><div style="color:var(--muted); font-size:0.7rem;">TD ${item.tahun_dinas}</div></div>
        <div style="color:var(--muted); font-size:0.7rem;">${formatIndoTimestamp(item.timestamp)}</div>
      </div>
    `).join("");
  });
}

document.getElementById("openS13ModalBtn")?.addEventListener("click", () => {
  document.getElementById("s13Modal").style.display = "flex";
});
document.getElementById("closeS13ModalBtn")?.addEventListener("click", () => {
  document.getElementById("s13Modal").style.display = "none";
});
document.getElementById("downloadS13Btn")?.addEventListener("click", async () => {
  const year = parseInt(document.getElementById("s13YearSelect").value, 10);
  generateS13Pdf(allTerritories, year, "ALL");
  await push(ref(db, "s13_logs"), {
    nama: currentProfile.name || currentUser.email.split("@")[0],
    email: currentUser.email.toLowerCase(),
    role_label: TIPE1_LABELS[currentProfile.role_daerah] || "Hamba Daerah",
    tahun_dinas: year,
    kdl: "ALL",
    timestamp: new Date().toISOString()
  });
  document.getElementById("s13Modal").style.display = "none";
});

function renderNotifications() {
  const list = Object.values(allTerritories);
  const dueCards = list.filter(t => isMyTerritory(t) && isAuditDue(t)).sort(sortByTerritoryNumber);
  const unassignedCount = hasTipe1Access ? list.filter(t => !t.kdl).length : 0;
  const totalNotif = dueCards.length + (unassignedCount > 0 ? 1 : 0);

  const badgeEl = document.getElementById("notifBadgeCount");
  if (totalNotif > 0) {
    badgeEl.textContent = totalNotif > 99 ? "99+" : totalNotif;
    badgeEl.style.display = "flex";
  } else {
    badgeEl.style.display = "none";
  }

  const container = document.getElementById("notifListContainer");
  const viewAllBtn = document.getElementById("notifViewAllDueBtn");
  if (totalNotif === 0) {
    document.getElementById("notifSubtitle").textContent = "Semua kartu terpantau aman";
    viewAllBtn.style.display = "none";
    container.innerHTML = `<div style="padding: 1.5rem; text-align: center; color: var(--muted); font-size: 0.82rem;">Belum ada notifikasi penting.</div>`;
    return;
  }

  document.getElementById("notifSubtitle").textContent = `${totalNotif} pemberitahuan perlu ditindaklanjuti`;
  viewAllBtn.style.display = dueCards.length > 0 ? "flex" : "none";

  let html = "";
  if (unassignedCount > 0) {
    html += `<div class="list-item" style="background: rgba(245,158,11,0.08);"><div class="item-info"><div class="item-title" style="color:var(--warning);">Peta Belum Masuk KDL</div><div class="item-sub">Ada ${unassignedCount} peta belum diatur KDL-nya.</div></div><span class="badge b-due">Info</span></div>`;
  }
  html += dueCards.map(t => `
    <div class="list-item is-due" onclick="document.getElementById('notifModal').style.display='none'; selectTerritory('${t.id}');">
      <div class="item-left"><span class="item-num">#${t.nomor}</span><div class="item-info"><div class="item-title">${cleanTerritoryName(t)}</div><div class="item-sub">${t.pemegang} • Jatuh tempo ${t.jatuh_tempo_audit}</div></div></div>
      <span class="badge b-due">Audit</span>
    </div>
  `).join("");
  container.innerHTML = html;
}

document.getElementById("notifBellBtn")?.addEventListener("click", () => {
  renderNotifications();
  document.getElementById("notifModal").style.display = "flex";
});
document.getElementById("closeNotifModalBtn")?.addEventListener("click", () => {
  document.getElementById("notifModal").style.display = "none";
});
document.getElementById("notifViewAllDueBtn")?.addEventListener("click", () => {
  document.getElementById("notifModal").style.display = "none";
  window.setQuickStatus("DUE");
});

// SWITCH KE MOBILE, TEMA & LOGOUT
document.getElementById("switchMobileBtn")?.addEventListener("click", () => {
  sessionStorage.setItem("forceMode", "mobile");
  window.location.href = "dashboard.html?mode=mobile";
});

const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const moonSvg = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
const sunSvg = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`;
const savedTheme = localStorage.getItem("theme") || "light";
document.documentElement.setAttribute("data-theme", savedTheme);
if (themeIcon) themeIcon.innerHTML = savedTheme === "dark" ? sunSvg : moonSvg;

themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  if (themeIcon) themeIcon.innerHTML = next === "dark" ? sunSvg : moonSvg;
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});