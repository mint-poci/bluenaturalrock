function fmtDDMM(isoStr) {
  if (!isoStr || !isoStr.includes("-")) return "";
  const [y, m, d] = isoStr.split("-");
  return `${d}/${m}`;
}

function fmtDDMMYY(isoStr) {
  if (!isoStr || !isoStr.includes("-")) return "";
  const [y, m, d] = isoStr.split("-");
  return `${d}/${m}/${y.slice(-2)}`;
}

function drawS13Header(doc, startY) {
  const left = 12;
  const colWidths = [16, 26, 36, 36, 36, 36]; // Total 186mm (pas di A4 210mm)
  const h1 = 7;
  const h2 = 9;

  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);
  doc.setLineWidth(0.35);

  // Kolom 1: No. daerah
  doc.setFillColor(217, 217, 217);
  doc.rect(left, startY, colWidths[0], h1 + h2, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text(["No.", "daerah"], left + colWidths[0] / 2, startY + 6.5, { align: "center" });

  // Kolom 2: Tanggal terakhir dikembalikan*
  let x = left + colWidths[0];
  doc.setFillColor(217, 217, 217);
  doc.rect(x, startY, colWidths[1], h1 + h2, "FD");
  doc.text(["Tanggal", "terakhir", "dikembalikan*"], x + colWidths[1] / 2, startY + 5, { align: "center" });

  // 4 Blok Dikerjakan oleh
  x += colWidths[1];
  for (let i = 0; i < 4; i++) {
    const w = colWidths[2 + i];
    const halfW = w / 2;

    doc.setFillColor(217, 217, 217);
    doc.rect(x, startY, w, h1, "FD");
    doc.setFontSize(7.5);
    doc.text("Dikerjakan oleh", x + w / 2, startY + 4.8, { align: "center" });

    doc.setFillColor(217, 217, 217);
    doc.rect(x, startY + h1, halfW, h2, "FD");
    doc.setFillColor(217, 217, 217);
    doc.rect(x + halfW, startY + h1, halfW, h2, "FD");
    doc.setFontSize(6.5);
    doc.text(["Tanggal", "diberikan"], x + halfW / 2, startY + h1 + 3.8, { align: "center" });
    doc.text(["Tanggal", "dikembalikan"], x + halfW + halfW / 2, startY + h1 + 3.8, { align: "center" });

    x += w;
  }
  return startY + h1 + h2;
}

function drawS13Row(doc, y, rowData) {
  const left = 12;
  const colWidths = [16, 26, 36, 36, 36, 36];
  const topH = 5.2;
  const botH = 4.8;
  const totalH = topH + botH;

  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);
  doc.setLineWidth(0.25);

  // Kolom 1: Nomor
  doc.rect(left, y, colWidths[0], totalH);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(String(rowData.nomor), left + colWidths[0] / 2, y + 6.2, { align: "center" });

  // Kolom 2: Terakhir dikembalikan
  let x = left + colWidths[0];
  doc.rect(x, y, colWidths[1], totalH);
  if (rowData.lastCompletedBefore) {
    doc.setFontSize(7.5);
    doc.text(rowData.lastCompletedBefore, x + colWidths[1] / 2, y + 6.2, { align: "center" });
  }

  // 4 Blok penugasan
  x += colWidths[1];
  for (let i = 0; i < 4; i++) {
    const w = colWidths[2 + i];
    const halfW = w / 2;
    const slot = rowData.slots[i] || null;

    doc.rect(x, y, w, topH);
    doc.rect(x, y + topH, halfW, botH);
    doc.rect(x + halfW, y + topH, halfW, botH);

    if (slot) {
      doc.setFontSize(7.5);
      const nameTxt = slot.pemegang.length > 21 ? slot.pemegang.slice(0, 20) + "…" : slot.pemegang;
      doc.text(nameTxt, x + w / 2, y + 3.7, { align: "center" });

      doc.setFontSize(7.2);
      if (slot.mulai) doc.text(slot.mulai, x + halfW / 2, y + topH + 3.4, { align: "center" });
      if (slot.kembali) doc.text(slot.kembali, x + halfW + halfW / 2, y + topH + 3.4, { align: "center" });
    }
    x += w;
  }
  return y + totalH;
}

export function generateS13Pdf(allTerritories, targetYear, kdlFilter = "ALL") {
  if (!window.jspdf) {
    alert("Library PDF masih dimuat, tunggu sebentar lalu coba lagi.");
    return;
  }

  const periodStart = `${targetYear - 1}-09-01`;
  const periodEnd = `${targetYear}-08-31`;

  let list = Object.values(allTerritories);
  if (kdlFilter !== "ALL") {
    list = list.filter(t => (t.kdl || "") === kdlFilter);
  }

  list.sort((a, b) => {
    const numA = parseInt(a.nomor, 10);
    const numB = parseInt(b.nomor, 10);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
    return String(a.nomor ?? "").localeCompare(String(b.nomor ?? ""), "id", { numeric: true });
  });

  if (list.length === 0) {
    alert("Tidak ada data peta untuk filter yang dipilih.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // Judul Halaman 1
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("CATATAN DAERAH TUGAS", 105, 14, { align: "center" });

  doc.setFontSize(10.5);
  doc.text("Tahun Dinas:", 24, 22);
  doc.text(String(targetYear), 56, 22);
  doc.setLineWidth(0.35);
  doc.line(50, 23.2, 70, 23.2);

  if (kdlFilter !== "ALL") {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.text(kdlFilter, 198, 22, { align: "right" });
  }

  let curY = drawS13Header(doc, 27);

  list.forEach((t) => {
    const hist = t.riwayat ? Object.values(t.riwayat) : [];

    // Tanggal terakhir dikembalikan sebelum periodStart
    const prevDates = hist
      .map(r => r.tanggal_kembali)
      .filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d < periodStart)
      .sort();
    const lastBefore = prevDates.length > 0 ? fmtDDMMYY(prevDates[prevDates.length - 1]) : "";

    // Blok penugasan dalam periode berjalan
    const periodSlots = [];
    hist.forEach(r => {
      const m = r.tanggal_mulai || "";
      const k = r.tanggal_kembali || "";
      const inRange = (m >= periodStart && m <= periodEnd) || (k >= periodStart && k <= periodEnd);
      if (inRange) {
        periodSlots.push({
          sortKey: m || k,
          pemegang: r.pemegang || "",
          mulai: fmtDDMM(m),
          kembali: /^\d{4}-\d{2}-\d{2}$/.test(k) ? fmtDDMM(k) : ""
        });
      }
    });

    // Pemegang aktif saat ini jika masuk periode
    if (t.pemegang && t.pemegang.trim() !== "") {
      const mAktif = t.tanggal_mulai || "";
      if (!mAktif || mAktif <= periodEnd) {
        periodSlots.push({
          sortKey: mAktif || "9999-12-31",
          pemegang: t.pemegang.trim(),
          mulai: fmtDDMM(mAktif),
          kembali: ""
        });
      }
    }

    periodSlots.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    if (curY + 10 > 282) {
      doc.addPage();
      curY = drawS13Header(doc, 12);
    }

    curY = drawS13Row(doc, curY, {
      nomor: t.nomor,
      lastCompletedBefore: lastBefore,
      slots: periodSlots.slice(0, 4)
    });
  });

  const kdlSlug = kdlFilter === "ALL" ? "Semua_KDL" : kdlFilter.replace(/\s+/g, "_");
  doc.save(`S-13_${kdlSlug}_${targetYear}.pdf`);
}