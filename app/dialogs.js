// Toasts, and in-page stand-ins for confirm() and prompt().
import { S, $ } from './state.js';

let toastTimer = 0;
export function toast(msg) {
  const t = $('toast'), g = $('gallery');
  (g.open ? g : $('stage')).append(t);   // over the gallery while it's open (a modal hides the page)
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- dialogs: in-page stand-ins for confirm() and prompt() --------------------------------------------------
export const dialog = $('dialog');
/**
 * Ask the user something in a dialog over the page. Resolves to true / false, or with `input` (the starting
 * text) to the text entered / null. opts { ok, cancel: button labels, input, danger: the OK button in the warning
 * colour }. Enter is OK; Escape, Cancel or a click outside is Cancel.
 */
export function ask(message, { ok = 'OK', cancel = 'Cancel', input, danger = false } = {}) {
  const el = (tag, props) => Object.assign(document.createElement(tag), props);
  const field = input === undefined ? null : el('input', { type: 'text', value: input, spellcheck: false });
  const okButton = el('button', { textContent: ok, className: danger ? 'danger' : '' });
  const cancelButton = el('button', { textContent: cancel });
  const body = el('div', { className: 'body' });
  body.append(el('p', { textContent: message }), ...(field ? [field] : []), el('div', { className: 'buttons' }));
  body.lastChild.append(cancelButton, okButton);
  dialog.replaceChildren(body);
  dialog.showModal();
  if (field) { field.focus(); field.select(); } else okButton.focus();
  return new Promise((resolve) => {
    const finish = (yes) => {
      dialog.close();
      resolve(field ? (yes ? field.value : null) : yes);
    };
    okButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    dialog.oncancel = (e) => { e.preventDefault(); finish(false); };
    dialog.onclick = (e) => { if (e.target === dialog) finish(false); };
    // The page's own shortcuts don't see keys pressed here.
    dialog.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target !== cancelButton) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
  });
}

/** Whether the current design can be replaced: unedited, or the user says so. */
export const mayDiscard = async (what) => !S.edited || S.model.parts.length <= 1 ||
  ask(`${what} Unsaved changes are lost.`, { ok: 'Discard changes', danger: true });

export const folderName = async (message, name = '') => (await ask(message, { input: name }))?.trim() || null;

/** `n` made a file name (without the characters file systems refuse). */
export const safeFileName = (n) => n.replace(/[\\/:*?"<>|]/g, '_').trim() || '_';
