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

let currentUser = null;
let currentProfile = { name: "Eden", role_daerah: "hamba_daerah", kdl: "", role_kdl: "" };
let hasTipe1Access = false;
let canEditTerritory = false;
let allTerritories = {};
let allMembers = {};
let activeFilter = "ALL";
let statusQuickFilter = "";
let selectedId = null;
let editHistoryMode = false;
let editingMemberEmail = null;
let bulkMode = false;
let selectedBulkIds = new Set();
let map = null;
let currentPolygon = null;

function emailToKey(email) {
  return email.toLowerCase().trim().replace(/\./g, ",");
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

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h < 11) return "Selamat pagi,";
  if (h < 15) return "Selamat siang,";
  if (h < 18) return "Selamat sore,";
  return "Selamat malam,";
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
  const hasKdlEditRole = Boolean(currentProfile.kdl && TIPE2_LABELS[currentProfile.role_kdl]);
  canEditTerritory = hasTipe1Access || hasKdlEditRole;

  if (!hasTipe1Access && !currentProfile.kdl) {
    alert("Akun Anda belum ditempatkan di KDL mana pun. Hubungi Hamba Daerah.");
    await signOut(auth);
    window.location.href = "index.html";
    return;
  }

  document.body.style.display = "flex";
  document.getElementById("greetingTime").textContent = getTimeGreeting();
  document.getElementById("greetingName").textContent = currentProfile.name || user.email.split("@")[0];

  const roleParts = [];
  if (TIPE1_LABELS[currentProfile.role_daerah]) roleParts.push(TIPE1_LABELS[currentProfile.role_daerah]);
  if (currentProfile.kdl && TIPE2_LABELS[currentProfile.role_kdl]) roleParts.push(TIPE2_LABELS[currentProfile.role_kdl]);

  const rolesEl = document.getElementById("greetingRolesText");
  if (roleParts.length > 0) {
    rolesEl.textContent = roleParts.join(" | ");
    rolesEl.style.display = "block";
  } else {
    rolesEl.style.display = "none";
  }

  document.getElementById("greetingKdlText").textContent = currentProfile.kdl || "Semua KDL";

  if (hasTipe1Access) {
    document.getElementById("bnavMembers").style.display = "flex";
    document.getElementById("toggleBulkBtn").style.display = "inline-flex";
    const s13Card = document.getElementById("s13FeatureCard");
  if (s13Card) s13Card.style.display = "block";
  listenS13Logs();
  } else {
    document.getElementById("pillPml").style.display = currentProfile.kdl === "KDL Pemalang" ? "inline-flex" : "none";
    document.getElementById("pillTgt").style.display = currentProfile.kdl === "KDL Tegal Timur" ? "inline-flex" : "none";
    document.getElementById("pillTgb").style.display = currentProfile.kdl === "KDL Tegal Barat" ? "inline-flex" : "none";
  }

  if (canEditTerritory) {
    document.getElementById("openS13ModalBtn").style.display = "inline-flex";
  }

  listenMembers();
  listenTerritories();
});

function isMyTerritory(t) {
  if (hasTipe1Access) return true;
  return Boolean(currentProfile.kdl) && (t.kdl || "") === currentProfile.kdl;
}

function addFourMonths(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + 4);
  return d.toISOString().split("T")[0];
}

function isAuditDue(t) {
  if (!t.pemegang || !t.jatuh_tempo_audit) return false;
  const today = new Date().toISOString().split("T")[0];
  return t.jatuh_tempo_audit <= today;
}

function listenMembers() {
  onValue(ref(db, "users"), (snap) => {
    allMembers = snap.val() || {};
    renderMembers();
    refreshNewMemberRoleOptions();
  });
}

function renderMembers() {
  const listEl = document.getElementById("memberList");
  const membersArr = Object.values(allMembers).map(normalizeMember);

  listEl.innerHTML = membersArr.map(m => {
    const isSuper = m.email.toLowerCase() === SUPER_ADMIN;
    const displayName = m.name || m.email.split("@")[0];
    const headline = formatMemberHeadline(m);

    return `
      <div class="member-row" onclick="openEditMemberModal('${m.email}')">
        <div class="member-avatar">${getInitials(displayName)}</div>
        <div class="member-info">
          <div class="member-name-row">
            <span class="member-name">${displayName}</span>
            ${isSuper ? `<span class="role-tag">Utama</span>` : ""}
          </div>
          <div class="member-headline">${headline}</div>
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
  if (!chosenKdl) {
    roleKdlSelectEl.value = "";
    return;
  }

  const leader = getKdlLeader(chosenKdl, excludeEmail);
  const optPengawas = roleKdlSelectEl.querySelector('option[value="pengawas_kelompok"]');
  const optHamba = roleKdlSelectEl.querySelector('option[value="hamba_kelompok"]');

  if (leader) {
    const info = ` (Sudah diisi ${leader.name || leader.email})`;
    optPengawas.disabled = true;
    optPengawas.textContent = `Pengawas Kelompok${info}`;
    optHamba.disabled = true;
    optHamba.textContent = `Hamba Kelompok${info}`;
    if (isLeaderRoleKdl(roleKdlSelectEl.value)) roleKdlSelectEl.value = "";
  } else {
    optPengawas.disabled = false;
    optPengawas.textContent = "Pengawas Kelompok";
    optHamba.disabled = false;
    optHamba.textContent = "Hamba Kelompok";
  }
}

function refreshNewMemberRoleOptions() {
  const kdlSel = document.getElementById("newMemberKdl");
  const roleKdlSel = document.getElementById("newMemberRoleKdl");
  if (kdlSel && roleKdlSel) syncRoleKdlOptions(kdlSel, roleKdlSel, "");
}

document.getElementById("newMemberKdl").addEventListener("change", refreshNewMemberRoleOptions);

document.getElementById("openAddMemberBtn").addEventListener("click", () => {
  document.getElementById("newMemberEmail").value = "";
  document.getElementById("newMemberName").value = "";
  document.getElementById("newMemberRoleDaerah").value = "";
  document.getElementById("newMemberKdl").value = "";
  document.getElementById("newMemberRoleKdl").value = "";
  refreshNewMemberRoleOptions();
  document.getElementById("addMemberModal").style.display = "flex";
});

document.getElementById("closeAddMemberBtn").addEventListener("click", () => {
  document.getElementById("addMemberModal").style.display = "none";
});

document.getElementById("addMemberBtn").addEventListener("click", async () => {
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

  await set(ref(db, `users/${emailToKey(email)}`), {
    email, name: name || email.split("@")[0], role_daerah: roleDaerah, kdl, role_kdl: roleKdl
  });
  document.getElementById("addMemberModal").style.display = "none";
});

window.openEditMemberModal = function(email) {
  if (!hasTipe1Access) return;
  const key = emailToKey(email);
  const raw = allMembers[key];
  if (!raw) return;

  const m = normalizeMember(raw);
  editingMemberEmail = m.email;
  const isSuper = m.email.toLowerCase() === SUPER_ADMIN;

  document.getElementById("editMemberEmailSub").textContent = m.email;
  document.getElementById("editMemberName").value = m.name || "";

  const roleDaerahField = document.getElementById("editRoleDaerahField");
  const roleDaerahSel = document.getElementById("editMemberRoleDaerah");
  roleDaerahSel.value = m.role_daerah || "";
  roleDaerahSel.disabled = isSuper;
  roleDaerahField.style.opacity = isSuper ? "0.65" : "1";

  const kdlSel = document.getElementById("editMemberKdl");
  const roleKdlSel = document.getElementById("editMemberRoleKdl");
  kdlSel.value = m.kdl || "";
  roleKdlSel.value = m.role_kdl || "";
  syncRoleKdlOptions(kdlSel, roleKdlSel, m.email);

  document.getElementById("deleteEditMemberBtn").style.display = isSuper ? "none" : "block";
  document.getElementById("editMemberModal").style.display = "flex";
};

document.getElementById("editMemberKdl").addEventListener("change", () => {
  syncRoleKdlOptions(document.getElementById("editMemberKdl"), document.getElementById("editMemberRoleKdl"), editingMemberEmail || "");
});

document.getElementById("closeEditMemberBtn").addEventListener("click", () => {
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});

document.getElementById("saveEditMemberBtn").addEventListener("click", async () => {
  if (!hasTipe1Access || !editingMemberEmail) return;
  const isSuper = editingMemberEmail.toLowerCase() === SUPER_ADMIN;
  const name = document.getElementById("editMemberName").value.trim() || editingMemberEmail.split("@")[0];
  const roleDaerah = isSuper ? "hamba_daerah" : document.getElementById("editMemberRoleDaerah").value;
  const kdl = document.getElementById("editMemberKdl").value;
  const roleKdl = kdl ? document.getElementById("editMemberRoleKdl").value : "";

  if (!roleDaerah && !kdl) return alert("Pilih minimal Peran Daerah (Tipe 1) atau Penempatan KDL (Tipe 2).");
  if (kdl && isLeaderRoleKdl(roleKdl)) {
    const conflict = getKdlLeader(kdl, editingMemberEmail);
    if (conflict) return alert(`${kdl} sudah memiliki ${TIPE2_LABELS[conflict.role_kdl]} (${conflict.name || conflict.email}).`);
  }

  await update(ref(db, `users/${emailToKey(editingMemberEmail)}`), {
    name, role_daerah: roleDaerah, kdl, role_kdl: roleKdl, role: null
  });
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});

document.getElementById("deleteEditMemberBtn").addEventListener("click", async () => {
  if (!hasTipe1Access || !editingMemberEmail || editingMemberEmail.toLowerCase() === SUPER_ADMIN) return;
  if (!confirm(`Hapus akses untuk ${editingMemberEmail}?`)) return;
  await remove(ref(db, `users/${emailToKey(editingMemberEmail)}`));
  document.getElementById("editMemberModal").style.display = "none";
  editingMemberEmail = null;
});

function listenTerritories() {
  onValue(ref(db, "territories"), (snap) => {
    allTerritories = snap.val() || {};
    renderHomeOverview();
    renderList();
    if (selectedId && allTerritories[selectedId] && document.getElementById("detailModal").style.display === "flex") {
      renderHistoryList(allTerritories[selectedId]);
    }
  });
}

function renderHomeOverview() {
  const list = Object.values(allTerritories);
  const mineList = list.filter(t => isMyTerritory(t));
  const workingCount = mineList.filter(t => t.pemegang && t.pemegang.trim() !== "").length;
  const availCount = mineList.length - workingCount;
  const dueCount = mineList.filter(t => isAuditDue(t)).length;

  document.getElementById("ovTotal").textContent = mineList.length;
  document.getElementById("ovWork").textContent = workingCount;
  document.getElementById("ovAvail").textContent = availCount;

  const alertEl = document.getElementById("homeAuditAlert");
  if (dueCount > 0) {
    alertEl.style.display = "flex";
    document.getElementById("alertDueCount").textContent = dueCount;
  } else {
    alertEl.style.display = "none";
  }

  const visibleKdls = hasTipe1Access ? KDL_LIST : [currentProfile.kdl];
  document.getElementById("breakdownTitle").textContent = hasTipe1Access ? "Sebaran per KDL" : "Ringkasan Wilayah";

  let html = visibleKdls.map(k => {
    const sub = list.filter(t => t.kdl === k);
    const active = sub.filter(t => t.pemegang && t.pemegang.trim() !== "").length;
    const pct = sub.length > 0 ? Math.round((active / sub.length) * 100) : 0;
    return `
      <div class="kdl-summary-row" onclick="openFilteredList('${k}')">
        <div class="kdl-row-top">
          <strong>${formatShortKdl(k)}</strong>
          <span style="color:var(--muted); font-size:0.78rem;">${active} / ${sub.length} peta</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
      </div>`;
  }).join("");

  if (hasTipe1Access) {
    const unassigned = list.filter(t => !t.kdl).length;
    if (unassigned > 0) {
      html += `
        <div class="kdl-summary-row" onclick="openFilteredList('UNASSIGNED')">
          <div class="kdl-row-top">
            <span style="color:var(--warning); font-weight:600;">Belum Masuk KDL</span>
            <span style="color:var(--muted); font-size:0.78rem;">${unassigned} peta</span>
          </div>
        </div>`;
    }
  }
  document.getElementById("kdlBreakdown").innerHTML = html;
}

function getVisibleTerritories() {
  const list = Object.values(allTerritories).filter(t => isMyTerritory(t));
  const search = document.getElementById("searchInput").value.toLowerCase();

  return list
    .filter(t => {
      const isWorking = t.pemegang && t.pemegang.trim() !== "";
      if (statusQuickFilter === "avail" && isWorking) return false;
      if (statusQuickFilter === "work" && !isWorking) return false;

      if (activeFilter === "DUE" && !isAuditDue(t)) return false;
      if (activeFilter === "PW" && !t.kunjungan_pw) return false;
      if (activeFilter === "PERTOKOAN" && (t.kategori || "Umum") !== "Pertokoan") return false;
      if (activeFilter === "UNASSIGNED" && t.kdl) return false;
      if (activeFilter.startsWith("KDL ") && t.kdl !== activeFilter) return false;

      if (search) {
        const hay = `${t.nomor} ${t.nama} ${t.pemegang} ${t.kdl || ''} ${t.kategori || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const numA = parseInt(a.nomor, 10);
      const numB = parseInt(b.nomor, 10);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
      return String(a.nomor ?? "").localeCompare(String(b.nomor ?? ""), "id", { numeric: true });
    });
}

function renderList() {
  const mineList = Object.values(allTerritories).filter(t => isMyTerritory(t));
  document.getElementById("cAll").textContent = mineList.length;
  document.getElementById("cPml").textContent = mineList.filter(t => t.kdl === "KDL Pemalang").length;
  document.getElementById("cTgt").textContent = mineList.filter(t => t.kdl === "KDL Tegal Timur").length;
  document.getElementById("cTgb").textContent = mineList.filter(t => t.kdl === "KDL Tegal Barat").length;
  document.getElementById("cPw").textContent = mineList.filter(t => Boolean(t.kunjungan_pw)).length;
  document.getElementById("cToko").textContent = mineList.filter(t => (t.kategori || "Umum") === "Pertokoan").length;
  document.getElementById("cDue").textContent = mineList.filter(t => isAuditDue(t)).length;

  const filtered = getVisibleTerritories();
  const container = document.getElementById("territoryList");
  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 1.75rem; text-align: center; color: var(--muted); font-size: 0.84rem;">Tidak ada peta ditemukan.</div>`;
    return;
  }

  container.innerHTML = filtered.map(t => {
    const due = isAuditDue(t);
    const isWorking = t.pemegang && t.pemegang.trim() !== "";
    let badge = `<span class="badge b-avail">Kosong</span>`;
    if (due) badge = `<span class="badge b-due">Audit</span>`;
    else if (isWorking) badge = `<span class="badge b-work">Aktif</span>`;

    const kdlLabel = formatShortKdl(t.kdl);
    const katLabel = t.kategori || "Umum";
    const subText = isWorking ? `${t.pemegang} • ${kdlLabel}` : `${kdlLabel} • ${katLabel}`;
    const checked = selectedBulkIds.has(t.id) ? "checked" : "";

    return `
      <div class="list-item ${due ? 'is-due' : ''}" onclick="handleItemClick('${t.id}')">
        <input type="checkbox" class="bulk-check" style="display:${bulkMode ? 'block' : 'none'};" ${checked} onclick="event.stopPropagation(); toggleBulkItem('${t.id}')">
        <div class="item-left">
          <span class="item-num">#${t.nomor}</span>
          <div class="item-info">
            <div class="item-title-row">
              <div class="item-title">${cleanTerritoryName(t)}</div>
              ${t.kunjungan_pw ? `<span class="pw-tag">Kunjungan PW</span>` : ""}
            </div>
            <div class="item-sub">${subText}</div>
          </div>
        </div>
        ${badge}
      </div>
    `;
  }).join("");
}

window.handleItemClick = function(id) {
  if (bulkMode) {
    toggleBulkItem(id);
    renderList();
  } else {
    openDetail(id);
  }
};

window.toggleBulkItem = function(id) {
  if (selectedBulkIds.has(id)) selectedBulkIds.delete(id);
  else selectedBulkIds.add(id);
  document.getElementById("selectedCount").textContent = selectedBulkIds.size;
  document.getElementById("bulkActionBar").style.display = selectedBulkIds.size > 0 ? "flex" : "none";
};

document.getElementById("toggleBulkBtn").addEventListener("click", () => {
  if (!hasTipe1Access) return;
  bulkMode = !bulkMode;
  selectedBulkIds.clear();
  const btn = document.getElementById("toggleBulkBtn");
  btn.classList.toggle("active", bulkMode);
  btn.querySelector("span").textContent = bulkMode ? "Batal" : "Pilih";
  document.getElementById("bulkSubbar").style.display = bulkMode ? "flex" : "none";
  document.getElementById("bulkActionBar").style.display = "none";
  renderList();
});

document.getElementById("selectAllVisibleBtn").addEventListener("click", () => {
  const visible = getVisibleTerritories();
  visible.forEach(t => selectedBulkIds.add(t.id));
  document.getElementById("selectedCount").textContent = selectedBulkIds.size;
  document.getElementById("bulkActionBar").style.display = selectedBulkIds.size > 0 ? "flex" : "none";
  renderList();
});

document.getElementById("applyBulkBtn").addEventListener("click", async () => {
  if (!hasTipe1Access || selectedBulkIds.size === 0) return;
  const rawAction = document.getElementById("bulkTargetAction").value;
  const [actionType, actionVal] = rawAction.split(":");
  const updates = {};

  selectedBulkIds.forEach(id => {
    if (actionType === "kdl") updates[`territories/${id}/kdl`] = actionVal;
    else if (actionType === "pw") updates[`territories/${id}/kunjungan_pw`] = (actionVal === "true");
    else if (actionType === "cat") updates[`territories/${id}/kategori`] = actionVal;
  });

  await update(ref(db), updates);
  bulkMode = false;
  selectedBulkIds.clear();
  const btn = document.getElementById("toggleBulkBtn");
  btn.classList.remove("active");
  btn.querySelector("span").textContent = "Pilih";
  document.getElementById("bulkSubbar").style.display = "none";
  document.getElementById("bulkActionBar").style.display = "none";
  renderList();
});

window.switchPage = function(pageId) {
  if (pageId === "pageMembers" && !hasTipe1Access) return;
  ["pageHome", "pageTerritories", "pageMembers"].forEach(p => {
    document.getElementById(p).style.display = p === pageId ? "block" : "none";
  });
  document.querySelectorAll(".bnav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.page === pageId);
  });
  const titles = { pageHome: "Terita", pageTerritories: "Daftar Peta", pageMembers: "Anggota" };
  document.getElementById("headerTitle").textContent = titles[pageId] || "Terita";

  if (pageId !== "pageTerritories") {
    document.getElementById("bulkActionBar").style.display = "none";
  }
};

window.openFilteredList = function(filterVal, statusFilter = "") {
  activeFilter = filterVal;
  statusQuickFilter = statusFilter;
  document.querySelectorAll(".pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.filter === filterVal);
  });
  switchPage("pageTerritories");
  renderList();
};

document.querySelectorAll(".bnav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

function closeModal() {
  document.getElementById("detailModal").style.display = "none";
  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
}

function renderHistoryList(t) {
  const histEl = document.getElementById("historyList");
  const toggleBtn = document.getElementById("toggleEditHistoryBtn");
  const entries = t.riwayat ? Object.entries(t.riwayat).reverse() : [];

  if (entries.length === 0) {
    toggleBtn.style.display = "none";
    histEl.innerHTML = `<div style="font-size:0.78rem; color:var(--muted);">Belum ada riwayat sebelumnya.</div>`;
    return;
  }

  toggleBtn.style.display = hasTipe1Access ? "inline-flex" : "none";
  toggleBtn.textContent = editHistoryMode ? "Selesai Kelola" : "Kelola Riwayat";
  toggleBtn.style.color = editHistoryMode ? "var(--primary)" : "var(--text)";

  histEl.innerHTML = entries.map(([histKey, r]) => `
    <div class="hist-item">
      <div style="min-width: 0; flex: 1;">
        <strong>${r.pemegang}</strong>
        <div style="color:var(--muted); font-size:0.72rem;">${r.keterangan || ''}</div>
      </div>
      <div style="text-align:right; font-size:0.72rem; color:var(--muted); flex-shrink: 0;">
        ${r.tanggal_mulai || '-'}<br>s/d ${r.tanggal_kembali || '-'}
      </div>
      ${editHistoryMode ? `
        <button type="button" class="btn-sm btn-logout" style="padding: 0.3rem 0.5rem; margin-left: 0.35rem;" onclick="deleteHistoryItem('${histKey}', '${(r.pemegang || '').replace(/'/g, "\\'")}')">
          Hapus
        </button>
      ` : ''}
    </div>
  `).join("");
}

document.getElementById("toggleEditHistoryBtn").addEventListener("click", () => {
  if (!selectedId || !allTerritories[selectedId]) return;
  editHistoryMode = !editHistoryMode;
  renderHistoryList(allTerritories[selectedId]);
});

window.deleteHistoryItem = async function(histKey, pemegangName) {
  if (!selectedId || !hasTipe1Access) return;
  if (!confirm(`Hapus permanen catatan riwayat atas nama "${pemegangName}"? Tindakan ini tidak bisa dibatalkan.`)) return;
  await remove(ref(db, `territories/${selectedId}/riwayat/${histKey}`));
};

window.fillHolderKdl = function(kdlName) {
  if (!canEditTerritory) return;
  document.getElementById("fPemegang").value = kdlName;
  const tglEl = document.getElementById("fTglMulai");
  if (!tglEl.value) tglEl.value = new Date().toISOString().split("T")[0];
};

document.getElementById("toggleAttrBtn").addEventListener("click", () => {
  const body = document.getElementById("attrBody");
  const chev = document.getElementById("attrChevron");
  const isOpen = body.style.display === "block";
  body.style.display = isOpen ? "none" : "block";
  chev.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
});

window.openDetail = function(id) {
  selectedId = id;
  editHistoryMode = false;
  const t = allTerritories[id];
  if (!t) return;

  document.getElementById("mNama").textContent = cleanTerritoryName(t);
  document.getElementById("mPwBadge").style.display = t.kunjungan_pw ? "inline-block" : "none";
  document.getElementById("mMetaSub").textContent = `${formatShortKdl(t.kdl)} • ${t.kategori || "Umum"}`;

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

  document.getElementById("attrBody").style.display = "none";
  document.getElementById("attrChevron").style.transform = "rotate(0deg)";

  inpPemegang.disabled = !canEditTerritory;
  inpTglMulai.disabled = !canEditTerritory;
  inpCatatan.disabled = !canEditTerritory;

  document.getElementById("kdlQuickChips").style.display = canEditTerritory ? "flex" : "none";
  document.getElementById("attrPanel").style.display = canEditTerritory ? "block" : "none";
  document.getElementById("fKdlField").style.display = hasTipe1Access ? "block" : "none";

  document.getElementById("viewOnlyNotice").style.display = canEditTerritory ? "none" : "block";
  document.getElementById("saveBtn").style.display = canEditTerritory ? "inline-flex" : "none";
  document.getElementById("primaryActionRow").style.gridTemplateColumns = canEditTerritory ? "1fr 1fr" : "1fr";

  const hasHolder = t.pemegang && t.pemegang.trim() !== "";
  document.getElementById("holderActionRow").style.display = (canEditTerritory && hasHolder) ? "grid" : "none";

  renderHistoryList(t);

  const modalEl = document.querySelector("#detailModal .modal");
  document.getElementById("detailModal").style.display = "flex";
  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  if (modalEl) modalEl.scrollTop = 0;

  setTimeout(() => {
    if (!map) {
      map = L.map("mapContainer").setView([-6.89, 109.38], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OSM" }).addTo(map);
    }
    map.invalidateSize();
    if (currentPolygon) map.removeLayer(currentPolygon);
    if (t.koordinat && t.koordinat.length > 0) {
      currentPolygon = L.polygon(t.koordinat, { color: "#2563eb", fillOpacity: 0.25 }).addTo(map);
      map.fitBounds(currentPolygon.getBounds());
    }
  }, 150);
};

document.getElementById("saveBtn").addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const t = allTerritories[selectedId];
  const pemegang = document.getElementById("fPemegang").value.trim();
  const tglMulai = document.getElementById("fTglMulai").value;
  let jatuhTempo = "";
  if (pemegang && tglMulai) {
    jatuhTempo = (tglMulai === t.tanggal_mulai && t.jatuh_tempo_audit) ? t.jatuh_tempo_audit : addFourMonths(tglMulai);
  }

  const payload = {
    pemegang,
    status: pemegang ? "Sedang Dikerjakan" : "Tersedia",
    tanggal_mulai: tglMulai,
    jatuh_tempo_audit: jatuhTempo,
    catatan: document.getElementById("fCatatan").value.trim(),
    nama: document.getElementById("fNamaDaerah").value.trim() || t.nama || "",
    kategori: document.getElementById("fKategori").value,
    mymaps_url: document.getElementById("fMyMapsUrl").value.trim(),
    kunjungan_pw: document.getElementById("fKunjunganPw").checked
  };

  if (hasTipe1Access) payload.kdl = document.getElementById("fKdlPeta").value;

  await update(ref(db, `territories/${selectedId}`), payload);
  closeModal();
});

document.getElementById("shareWaBtn").addEventListener("click", () => {
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

document.getElementById("auditContinueBtn").addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const pemegang = document.getElementById("fPemegang").value.trim();
  if (!pemegang) return;
  const today = new Date().toISOString().split("T")[0];
  const nextDue = addFourMonths(today);

  await push(ref(db, `territories/${selectedId}/riwayat`), {
    pemegang,
    tanggal_mulai: document.getElementById("fTglMulai").value || today,
    keterangan: `Audit 4 Bln (${today}): Lanjut`,
    tanggal_kembali: today
  });
  await update(ref(db, `territories/${selectedId}`), {
    tanggal_mulai: today,
    jatuh_tempo_audit: nextDue
  });
  openDetail(selectedId);
});

document.getElementById("finishBtn").addEventListener("click", async () => {
  if (!selectedId || !canEditTerritory) return;
  const pemegang = document.getElementById("fPemegang").value.trim();
  if (!pemegang) return;
  const today = new Date().toISOString().split("T")[0];

  await push(ref(db, `territories/${selectedId}/riwayat`), {
    pemegang,
    tanggal_mulai: document.getElementById("fTglMulai").value || today,
    keterangan: "Selesai & Dikembalikan",
    tanggal_kembali: today
  });
  await update(ref(db, `territories/${selectedId}`), {
    pemegang: "", status: "Tersedia", tanggal_mulai: "", jatuh_tempo_audit: "", catatan: ""
  });
  openDetail(selectedId);
});

document.querySelectorAll(".pill-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".pill-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
    statusQuickFilter = "";
    renderList();
  });
});

document.getElementById("closeModalBtn").addEventListener("click", closeModal);
document.getElementById("searchInput").addEventListener("input", renderList);
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const moonSvg = `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`;
const sunSvg = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`;

const savedTheme = localStorage.getItem("theme") || "light";
document.documentElement.setAttribute("data-theme", savedTheme);
themeIcon.innerHTML = savedTheme === "dark" ? sunSvg : moonSvg;

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  themeIcon.innerHTML = next === "dark" ? sunSvg : moonSvg;
});

document.getElementById("openS13ModalBtn").addEventListener("click", () => {
  if (!canEditTerritory) return;
  const kdlField = document.getElementById("s13KdlField");
  const kdlSelect = document.getElementById("s13KdlSelect");

  if (hasTipe1Access) {
    kdlField.style.display = "block";
    kdlSelect.value = "ALL";
  } else {
    kdlField.style.display = "none";
    kdlSelect.value = currentProfile.kdl;
  }
  document.getElementById("s13Modal").style.display = "flex";
});

document.getElementById("closeS13ModalBtn").addEventListener("click", () => {
  document.getElementById("s13Modal").style.display = "none";
});

document.getElementById("downloadS13Btn").addEventListener("click", () => {
  const year = parseInt(document.getElementById("s13YearSelect").value, 10);
  const kdlVal = hasTipe1Access ? document.getElementById("s13KdlSelect").value : currentProfile.kdl;
  generateS13Pdf(allTerritories, year, kdlVal);
  document.getElementById("s13Modal").style.display = "none";
});

// === LOG & EXPORT S-13 (KHUSUS 4 ROLE TIPE 1) ===
function listenS13Logs() {
  if (!hasTipe1Access) return;
  onValue(ref(db, "s13_logs"), (snap) => {
    const raw = snap.val() || {};
    const logs = Object.values(raw).sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));

    const lastBarText = document.getElementById("s13LastLogText");
    const logListEl = document.getElementById("s13LogList");

    if (logs.length === 0) {
      lastBarText.textContent = "Belum ada riwayat generate S-13.";
      logListEl.innerHTML = `<div style="font-size: 0.78rem; color: var(--muted);">Belum ada riwayat cetak.</div>`;
      return;
    }

    const latest = logs[0];
    const latestKdl = latest.kdl === "ALL" ? "Semua KDL" : latest.kdl;
    lastBarText.textContent = `Terakhir: TD ${latest.tahun_dinas} (${latestKdl}) • oleh ${latest.nama} (${latest.role_label}) • ${formatIndoTimestamp(latest.timestamp)}`;

    logListEl.innerHTML = logs.slice(0, 10).map(item => {
      const kdlText = item.kdl === "ALL" ? "Semua KDL" : item.kdl;
      return `
        <div class="hist-item">
          <div style="min-width: 0; flex: 1;">
            <strong>${item.nama}</strong> <span class="role-tag" style="margin-left: 0.25rem;">${item.role_label}</span>
            <div style="color: var(--muted); font-size: 0.72rem; margin-top: 0.12rem;">Tahun Dinas ${item.tahun_dinas} • ${kdlText}</div>
          </div>
          <div style="text-align: right; font-size: 0.72rem; color: var(--muted); flex-shrink: 0;">
            ${formatIndoTimestamp(item.timestamp)}
          </div>
        </div>
      `;
    }).join("");
  });
}

document.getElementById("openS13ModalBtn").addEventListener("click", () => {
  if (!hasTipe1Access) return;
  document.getElementById("s13KdlField").style.display = "block";
  document.getElementById("s13KdlSelect").value = "ALL";
  document.getElementById("s13Modal").style.display = "flex";
});

document.getElementById("closeS13ModalBtn").addEventListener("click", () => {
  document.getElementById("s13Modal").style.display = "none";
});

document.getElementById("downloadS13Btn").addEventListener("click", async () => {
  if (!hasTipe1Access) return;
  const year = parseInt(document.getElementById("s13YearSelect").value, 10);
  const kdlVal = document.getElementById("s13KdlSelect").value;

  generateS13Pdf(allTerritories, year, kdlVal);

  const roleLabel = TIPE1_LABELS[currentProfile.role_daerah] || "Hamba Daerah";
  await push(ref(db, "s13_logs"), {
    nama: currentProfile.name || currentUser.email.split("@")[0],
    email: currentUser.email.toLowerCase(),
    role_label: roleLabel,
    tahun_dinas: year,
    kdl: kdlVal,
    timestamp: new Date().toISOString()
  });

  document.getElementById("s13Modal").style.display = "none";
});