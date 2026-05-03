// ═══════════════════════════════════════════════════════════════
// MAIL-PDF.JS — Génération PDF et envoi mail
// Dépend de : shared.js (state, toast, helpers exposés sur window)
// Proxy utilisé : pdf-sendtomail.receptionroulier.workers.dev
// ═══════════════════════════════════════════════════════════════

const MAIL_PROXY = 'https://pdf-sendtomail.receptionroulier.workers.dev';

// ── Vérifications Gmail communes ──
function _checkGmailConfig() {
  if (!state.config.emailFrom) {
    toast('Adresse Gmail expéditeur non configurée (Config → Emails)', 'error'); return false;
  }
  if (!state.config.gmailAuthorized) {
    toast('Gmail non autorisé — allez dans Config → Emails → Autoriser Gmail', 'error'); return false;
  }
  if (!state.config.emailWeek) {
    toast('Adresse destinataire non configurée (Config → Emails)', 'error'); return false;
  }
  return true;
}

// ── Envoi effectif via le worker mail dédié ──
async function _sendViaProxy({ subject, bodyText, fileName, pdfBase64 }) {
  toast('⏳ Envoi du mail…', 'info');
  try {
    const r = await fetch(MAIL_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'sendMail',
        from: state.config.emailFrom,
        to:   state.config.emailWeek,
        cc:   state.config.emailCcWeek  || '',
        bcc:  state.config.emailBccWeek || '',
        subject,
        body: bodyText,
        attachment: { filename: fileName, content: pdfBase64 }
      })
    });
    const data = await r.json();
    if (data.ok) {
      return true;
    } else {
      toast('Erreur envoi : ' + (data.error || 'inconnue'), 'error');
      return false;
    }
  } catch(e) {
    toast("Erreur réseau lors de l'envoi", 'error');
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS PDF COMMUNS
// ═══════════════════════════════════════════════════════════════

async function _savePDFWithFallback(doc, fileName, configuredPath) {
  const blob = doc.output('blob');
  if (configuredPath && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        startIn: 'downloads',
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast('PDF enregistré ✓');
      return;
    } catch(e) {
      if (e.name !== 'AbortError') console.warn('[PDF] showSaveFilePicker échec, fallback:', e);
    }
  }
  doc.save(fileName);
}

function _pdfParseColor(str) {
  if (!str) return [120, 130, 145];
  const h = str.replace('#', '');
  if (h.length === 6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  const m = str.match(/\d+/g);
  if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
  return [120, 130, 145];
}

const _PDF_COLOR_MAP_RGB = { rouge:[255,77,109], violet:[167,139,250], vert:[0,200,150], bleu:[59,143,255], jaune:[255,208,96] };
const _MONTHS_LONG = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

// Dessine l'effectif d'un jour sur le doc jsPDF à partir de la position y donnée.
function _pdfRenderDay(doc, dayIdx, W, margin, startY) {
  const GREY_CARD = [215, 220, 228];
  const H = 297;
  const sectionsMap = getSectionsMap();
  const daySlots = state.slots[dayIdx] || {};

  const cardW     = W - 2 * margin;
  const memberH   = 9;
  const secTitleH = 8;
  const hoursH    = 6;
  const innerPad  = 2.5;
  const memberPad = 1.5;

  let y = startY;

  SECTIONS_ORDER.forEach(secId => {
    const sec   = sectionsMap[secId];
    const slots = daySlots[secId] || [];
    if (slots.length === 0) return;

    const secRGB = _pdfParseColor(sec.color);

    if (y + secTitleH > H - 15) { doc.addPage(); y = 20; }
    doc.setFillColor(...secRGB);
    doc.roundedRect(margin, y, cardW, secTitleH, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(255, 255, 255);
    doc.text(sec.name.toUpperCase(), margin + 5, y + 5.5);
    y += secTitleH;

    if (sec.hours) {
      if (y + hoursH > H - 15) { doc.addPage(); y = 20; }
      doc.setFillColor(235, 239, 246);
      doc.roundedRect(margin, y, cardW, hoursH, 2, 2, 'F');
      doc.setDrawColor(...GREY_CARD);
      doc.setLineWidth(0.25);
      doc.roundedRect(margin, y, cardW, hoursH, 2, 2, 'S');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(70, 85, 110);
      const hW = doc.getTextWidth(sec.hours);
      doc.text(sec.hours, margin + (cardW - hW) / 2, y + 4);
      y += hoursH;
    }

    y += 1;

    const membersInSec = slots.map(slot => {
      const key = gkey(dayIdx + '_' + secId + '_' + slot.id);
      const workerId = state.planningModified[key] !== undefined
        ? state.planningModified[key] : state.planning[key];
      const w = getWorker(workerId);
      return { slot, workerId, w };
    });

    const totalCMH = innerPad + membersInSec.length * (memberH + memberPad) - memberPad + innerPad;
    if (y + totalCMH > H - 15) { doc.addPage(); y = 20; }

    doc.setFillColor(246, 248, 251);
    doc.roundedRect(margin, y, cardW, totalCMH, 2, 2, 'F');
    doc.setDrawColor(...GREY_CARD);
    doc.setLineWidth(0.25);
    doc.roundedRect(margin, y, cardW, totalCMH, 2, 2, 'S');

    let cy = y + innerPad;

    membersInSec.forEach(({ slot, workerId, w }) => {
      if (cy + memberH > H - 15) { doc.addPage(); cy = 20; }

      const workerColorKey = state.config?.workerColors?.[workerId];
      const memberRGB  = workerColorKey ? _PDF_COLOR_MAP_RGB[workerColorKey] : [190, 195, 205];
      const displayName   = w ? (w.lastName + ' ' + w.firstName) : (workerId ? 'Hors groupe' : '—');
      const displayMatric = w ? (w.matricule || '—') : '—';
      const postLabel     = slot.label || '';

      const mLeft = margin + innerPad;
      const mW    = cardW - 2 * innerPad;
      const midY  = cy + memberH / 2 + 1.5;

      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...memberRGB);
      doc.setLineWidth(0.6);
      doc.roundedRect(mLeft, cy, mW, memberH, 1.5, 1.5, 'FD');

      const textLeft = mLeft + 5;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(150, 155, 165);
      doc.text(postLabel, textLeft, midY);

      const posteW = doc.getTextWidth(postLabel);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(25, 30, 45);
      doc.text(displayName, textLeft + posteW + 4, midY);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(100, 110, 130);
      const matW = doc.getTextWidth(displayMatric);
      doc.text(displayMatric, mLeft + mW - matW - 3, midY);

      cy += memberH + memberPad;
    });

    y = cy - memberPad + 5;
  });

  return y;
}

// Header TRANSMANUTENTION commun à tous les PDFs
function _pdfHeader(doc, W, margin) {
  const BLUE = [47, 117, 181];
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(20);
  doc.setTextColor(...BLUE);
  doc.text('TRANSMANUTENTION', margin, 15);
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(0.5);
  doc.line(margin, 20, W - margin, 20);
  return BLUE;
}

// Pied de page commun
function _pdfFooter(doc, margin) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(170, 170, 180);
  doc.text('Document généré le ' + new Date().toLocaleDateString('fr-FR') + ' par Gestion Parc Réception Roulier', margin, 289);
}

// ═══════════════════════════════════════════════════════════════
// PDF JOURNALIER
// ═══════════════════════════════════════════════════════════════

async function generateDayPDF(dayIdx, save = true) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return; }

  const d = addDays(state.weekStart, dayIdx);
  const dateLabelLong = d.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  const dateLabelPDF  = dateLabelLong.replace(/\b\w/g, c => c.toUpperCase());

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, margin = 14;
  const BLUE = _pdfHeader(doc, W, margin);

  const fs = 11;
  const titre = 'Effectif Équipe Parc Réception Roulier du ' + dateLabelPDF;
  doc.setFontSize(fs);
  doc.setFont('helvetica', 'bold');
  const titreW = doc.getTextWidth(titre);
  const scale  = titreW > (W - 2*margin) ? (W - 2*margin) / titreW : 1;

  doc.setFontSize(fs * scale);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 35, 50);
  doc.text(titre, margin, 29);

  _pdfRenderDay(doc, dayIdx, W, margin, 36);
  _pdfFooter(doc, margin);

  const dayCapit  = d.toLocaleDateString('fr-FR', {weekday:'long'}).replace(/\b\w/, c => c.toUpperCase());
  const monthName = d.toLocaleDateString('fr-FR', {month:'long'});
  const fileName  = `Effectif_Parc_Roulier_Réception_du_${dayCapit}-${d.getDate()}-${monthName}-${d.getFullYear()}.pdf`;

  if (save) await _savePDFWithFallback(doc, fileName, state.config.pdfPathDaily || '');
  return { doc, dateLabelLong, fileName };
}

// ═══════════════════════════════════════════════════════════════
// PDF HEBDOMADAIRE
// ═══════════════════════════════════════════════════════════════

async function generateWeeklyPDF(save = true) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return; }

  const wn = getWeekNum(state.weekStart);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, margin = 14;
  let firstPage = true;

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const daySlots = state.slots[dayIdx] || {};
    const hasSlots = SECTIONS_ORDER.some(secId => (daySlots[secId] || []).length > 0);
    if (!hasSlots) continue;

    if (!firstPage) doc.addPage();
    firstPage = false;

    const d = addDays(state.weekStart, dayIdx);
    const dateLabel = DAYS[dayIdx] + ' ' + d.getDate() + ' ' + _MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();

    const BLUE = _pdfHeader(doc, W, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 35, 50);
    doc.text('Effectif Équipe Parc Réception Roulier', margin, 27);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80, 90, 110);
    doc.text(dateLabel + '  —  Semaine ' + wn, margin, 33);

    _pdfRenderDay(doc, dayIdx, W, margin, 40);
    _pdfFooter(doc, margin);
  }

  if (firstPage) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(120, 130, 145);
    doc.text('Aucune affectation pour la semaine ' + wn, 14, 50);
  }

  const fileName = `Planning_Réception_Semaine${wn}.pdf`;
  if (save) await _savePDFWithFallback(doc, fileName, state.config.pdfPathWeekly || '');
  return { doc, fileName };
}

// ═══════════════════════════════════════════════════════════════
// PDF DEMANDE DE CONGÉS
// ═══════════════════════════════════════════════════════════════

async function generateFicheConges(workerId, selections, saveLocal = true) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return null; }

  const worker = getWorker(workerId);
  if (!worker) return null;

  const allDays = {}, codeCounts = {};
  selections.forEach(sel => {
    Object.entries(sel.days).forEach(([iso, code]) => {
      allDays[iso] = code;
      codeCounts[code] = (codeCounts[code] || 0) + 1;
    });
  });

  const sortedISO = Object.keys(allDays).sort();
  const duFR = sortedISO[0]             ? isoToFR(sortedISO[0])                         : '—';
  const auFR = sortedISO[sortedISO.length-1] ? isoToFR(sortedISO[sortedISO.length-1])   : '—';
  const today = new Date().toLocaleDateString('fr-FR');
  const year  = new Date().getFullYear();

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, H = 297, margin = 18;

  // Header
  const BLUE = [47, 117, 181];
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(22);
  doc.setTextColor(...BLUE);
  doc.text('TRANSMANUTENTION', margin, 16);
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(0.5);
  doc.line(margin, 22, W - margin, 22);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(50, 55, 70);
  const titleStr = 'DEMANDE DE CONGÉS ' + year;
  doc.text(titleStr, W - margin - doc.getTextWidth(titleStr), 28);

  let y = 38;
  const fieldH = 18, labelH = 5;
  const col3W  = (W - 2*margin - 8) / 3;
  const col1x  = margin, col2x = col1x + col3W + 4, col3x = col2x + col3W + 4;
  const col2old = W/2 + 4, colW = W/2 - margin - 4;

  function drawField(x, fy, w, label, value) {
    doc.setFillColor(248, 248, 252);
    doc.roundedRect(x, fy, w, fieldH, 2, 2, 'F');
    doc.setDrawColor(200, 205, 215); doc.setLineWidth(0.4);
    doc.roundedRect(x, fy, w, fieldH, 2, 2, 'S');
    doc.setFillColor(...BLUE); doc.rect(x, fy, 3, fieldH, 'F');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 140, 155);
    doc.text(label.toUpperCase(), x+6, fy+labelH);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30, 35, 50);
    doc.text(String(value || '—'), x+6, fy+labelH+7);
  }

  drawField(col1x, y, col3W, 'Matricule', worker.matricule || '—');
  drawField(col2x, y, col3W, 'Nom', worker.lastName);
  drawField(col3x, y, col3W, 'Prénom', worker.firstName);
  y += fieldH + 6;

  drawField(col1x, y, colW, 'Du', duFR);
  drawField(col2old, y, colW, 'Au', auFR);
  y += fieldH + 6;

  // Bloc nombre de jours (hauteur variable selon nb de codes)
  const codeEntries = Object.entries(codeCounts);
  const nbFieldH = Math.max(fieldH + 4, 8 + codeEntries.length * 9);
  doc.setFillColor(248, 248, 252);
  doc.roundedRect(col1x, y, W-2*margin, nbFieldH, 2, 2, 'F');
  doc.setDrawColor(200, 205, 215); doc.setLineWidth(0.4);
  doc.roundedRect(col1x, y, W-2*margin, nbFieldH, 2, 2, 'S');
  doc.setFillColor(...BLUE); doc.rect(col1x, y, 3, nbFieldH, 'F');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 140, 155);
  doc.text('NOMBRE DE JOURS', col1x+6, y+labelH);
  let lineY = y + labelH + 6;
  codeEntries.forEach(([code, n]) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BLUE);
    doc.text(n + ' ' + code, col1x+6, lineY);
    lineY += 9;
  });
  y += nbFieldH + 6;

  // Signature
  const sigH = 32;
  drawField(col1x, y, colW, 'Fait le', today);
  doc.setFillColor(248, 248, 252);
  doc.roundedRect(col2old, y, colW, sigH, 2, 2, 'F');
  doc.setDrawColor(200, 205, 215); doc.setLineWidth(0.4);
  doc.roundedRect(col2old, y, colW, sigH, 2, 2, 'S');
  doc.setFillColor(...BLUE); doc.rect(col2old, y, 3, sigH, 'F');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(140, 140, 155);
  doc.text('SIGNATURE', col2old+6, y+labelH);
  y += sigH + 10;

  // Tableau détail
  if (selections.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...BLUE);
    doc.text('DÉTAILS DES CONGÉS', col1x, y);
    doc.setDrawColor(...BLUE); doc.setLineWidth(0.6);
    doc.line(col1x, y+1.5, col1x+55, y+1.5);
    y += 8;

    const tC1=col1x, tW1=20, tC2=col1x+20, tW2=40, tC3=col1x+60, tW3=40, tC4=col1x+100, tW4=20;
    const tRowH=8, tTotalW=tW1+tW2+tW3+tW4;

    doc.setFillColor(...BLUE); doc.rect(tC1, y, tTotalW, tRowH, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(255,255,255);
    ['Type','Du','Au','Jours'].forEach((h,i) => doc.text(h, [tC1,tC2,tC3,tC4][i]+2, y+5.5));
    y += tRowH;

    selections.forEach((sel, idx) => {
      const mainCode = sel.code;
      const nbJours  = Object.values(sel.days).filter(c => c === mainCode).length;
      doc.setFillColor(idx%2===0?255:250, idx%2===0?255:248, idx%2===0?255:245);
      doc.rect(tC1, y, tTotalW, tRowH, 'F');
      doc.setDrawColor(220,222,228); doc.setLineWidth(0.2);
      doc.line(tC1, y+tRowH, tC1+tTotalW, y+tRowH);
      [tC2,tC3,tC4].forEach(cx => doc.line(cx, y, cx, y+tRowH));
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...BLUE);
      doc.text(mainCode, tC1+2, y+5.5);
      doc.setTextColor(30,35,50); doc.setFont('helvetica','normal');
      doc.text(isoToFR(sel.from), tC2+2, y+5.5);
      doc.text(sel.from===sel.to?'—':isoToFR(sel.to), tC3+2, y+5.5);
      doc.setFont('helvetica','bold'); doc.text(nbJours+' j', tC4+2, y+5.5);
      y += tRowH;
    });
    doc.setDrawColor(180,185,200); doc.setLineWidth(0.4);
    doc.rect(tC1, y-tRowH*selections.length-tRowH, tTotalW, tRowH*(selections.length+1), 'S');
  }

  // Pied de page
  doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(170,170,180);
  doc.text('Document généré le ' + today + ' par Gestion Parc Réception Roulier', margin, H-10);

  const safeName = (worker.lastName+'-'+worker.firstName+'-'+(worker.matricule||'X'))
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9-]/g,'_');
  const fileName = 'Feuille_Conges_' + safeName + '.pdf';

  if (saveLocal) await _savePDFWithFallback(doc, fileName, state.config.pdfPathConges || '');
  return { doc, fileName };
}

// ═══════════════════════════════════════════════════════════════
// ENVOIS MAIL
// ═══════════════════════════════════════════════════════════════

async function sendDailyMail(dayIdx) {
  if (!_checkGmailConfig()) return;
  toast('⏳ Génération du PDF…', 'info');

  let fileName, pdfBase64, dateLabelLong;
  try {
    const result = await generateDayPDF(dayIdx, false);
    if (!result) return;
    ({ dateLabelLong, fileName } = result);
    pdfBase64 = result.doc.output('datauristring').split(',')[1];
  } catch(e) {
    console.error('[sendDailyMail] PDF error:', e);
    toast('Erreur génération PDF', 'error'); return;
  }

  const subject  = `Effectif Parc Réception Roulier pour le ${dateLabelLong}`;
  const bodyText = `Bonjour,\n\nCi-joint l'effectif Parc Réception Roulier pour le ${dateLabelLong}.\n\n\nGestion Parc Réception Roulier`;
  const ok = await _sendViaProxy({ subject, bodyText, fileName, pdfBase64 });
  if (ok) toast('✅ Mail journalier envoyé !');
}

async function sendWeeklyMail() {
  if (!_checkGmailConfig()) return;
  toast('⏳ Génération du PDF en cours…', 'info');

  let fileName, pdfBase64;
  try {
    const result = await generateWeeklyPDF(false);
    if (!result) return;
    ({ fileName } = result);
    pdfBase64 = result.doc.output('datauristring').split(',')[1];
  } catch(e) {
    console.error('[sendWeeklyMail] PDF error:', e);
    toast('Erreur génération PDF', 'error'); return;
  }

  const wn       = getWeekNum(state.weekStart);
  const subject  = `Prévision d'effectif Parc Réception Roulier — Semaine ${wn}`;
  const bodyText = `Bonjour,\n\nCi-joint prévision d'effectif Parc Réception Roulier pour la Semaine ${wn}.\n\n\nGestion Parc Réception Roulier`;
  const ok = await _sendViaProxy({ subject, bodyText, fileName, pdfBase64 });
  if (ok) toast('✅ Mail hebdomadaire envoyé !');
}

async function sendCongesMail(workerId, selections) {
  if (!_checkGmailConfig()) return;
  toast('⏳ Génération de la fiche PDF…', 'info');

  let fileName, pdfBase64;
  try {
    const result = await generateFicheConges(workerId, selections, false);
    if (!result) return;
    ({ fileName } = result);
    pdfBase64 = result.doc.output('datauristring').split(',')[1];
  } catch(e) {
    console.error('[sendCongesMail] PDF error:', e);
    toast('Erreur génération PDF', 'error'); return;
  }

  const worker     = getWorker(workerId);
  const workerName = worker ? (worker.lastName + ' ' + worker.firstName) : '?';
  const lignes = selections.map(sel => {
    const mainCode = sel.code;
    const mainDays = Object.values(sel.days).filter(c => c === mainCode).length;
    return sel.from === sel.to
      ? `  - ${mainCode} : ${isoToFR(sel.from)} (${mainDays} j)`
      : `  - ${mainCode} : ${isoToFR(sel.from)} → ${isoToFR(sel.to)} (${mainDays} j de ${mainCode})`;
  });

  const subject  = `Demande de congés — ${workerName}`;
  const bodyText = `Bonjour,\n\nCi-joint la demande de congés pour ${workerName} :\n\n${lignes.join('\n')}\n\n\nGestion Parc Réception Roulier`;
  const ok = await _sendViaProxy({ subject, bodyText, fileName, pdfBase64 });
  if (ok) toast('✅ Mail demande de congés envoyé !');
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

window.generateDayPDF     = generateDayPDF;
window.generateWeeklyPDF  = generateWeeklyPDF;
window.generateFicheConges = generateFicheConges;
window.sendDailyMail      = sendDailyMail;
window.sendWeeklyMail     = sendWeeklyMail;
window.sendCongesMail     = sendCongesMail;
