// Order o9d97 (Shubham: "Let this app have a native browser like Chrome, and let the overlay control it like it does app control"), o02a5 (tabs for
// the PC and the phone) and o34a3 ("I should be able to use and navigate using my assistant here"): the Assistant's eyes and hands inside a Browser
// tab, the same on both sides. LOOK_SCRIPT runs inside the tab's page (on the PC through the browser's debugging connection, on the phone through
// the app's WebView) and answers what is on screen to press or fill, with refs (b1, b2, ...), and the words on screen; the same script points at
// an element before a real click or tap, focuses a field before real typing, and scrolls. The rest here is pure: which presses are Shubham's alone
// (approvals, sends, payments, deletes, installs, sign-ups; a password field, never), and the screen as the Assistant reads it.
//
// The script is plain JavaScript in a string (it is sent to the page as it is): no template literals inside, and it must stay synchronous (the
// phone's WebView does not wait for a promise).

import { agentMayOpen, BROWSER_PRIVATE_NOTE } from './browser.ts'

/** One thing on the tab's screen to press or fill. */
export interface LookItem {
  ref: string
  role: string
  label: string
  /** input / textarea: its type ("text", "email", "search", "checkbox"...); "editable" for a content-editable element. */
  kind?: string
  value?: string
  options?: string[]
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  /** A link's full address. */
  href?: string
  /** A password, a one-time code or a card number: never typed into, never read. */
  secret?: boolean
  /** A search field (Enter there only searches). */
  search?: boolean
  /** In a form. */
  form?: boolean
  /** A button that sends its form. */
  submits?: boolean
  /** A file picker (an upload). */
  file?: boolean
}

export interface LookResult {
  url: string
  title: string
  items: LookItem[]
  /** Not listed (the cap). */
  more: number
  text: string
  scroll: { top: number; max: number }
  w: number
  h: number
}

/** Where an element is now, after it was scrolled into view: CSS px of the page (x, y) and physical px of the view (px, py). */
export interface LookPoint {
  ok: boolean
  gone?: boolean
  x: number
  y: number
  px: number
  py: number
  /** What covers it, when ok is false. */
  covered?: string
  item?: LookItem
}

/**
 * The script. Called as `LOOK_SCRIPT + '(' + JSON.stringify(args) + ')'`; args.op: look | point | focus | insert | choose | focused | scroll.
 * Its refs are kept in the page (window.__sadLook) until the next look.
 */
export const LOOK_SCRIPT = String.raw`(function (a) {
  'use strict';
  var S = window.__sadLook || (window.__sadLook = { refs: {}, n: 0 });
  var W = typeof WeakRef === 'function' ? WeakRef : null;
  function keep(el) { return W ? new W(el) : el; }
  function get(ref) {
    var k = S.refs[String(ref || '')];
    if (!k) return null;
    var el = W && k instanceof W ? k.deref() : k;
    return el && el.isConnected ? el : null;
  }
  function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 80); }
  var SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=searchbox],[role=textbox],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    if (el.closest('[inert],[aria-hidden=true]')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return true;
  }
  function inView(r) { return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; }
  function hitAt(x, y) { return document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, x)), Math.min(innerHeight - 1, Math.max(0, y))); }
  function reach(el, r) {
    var h = hitAt(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h) || h.contains(el));
  }
  function labelOf(el) {
    var v = clean(el.getAttribute('aria-label'));
    if (v) return v;
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var t = clean(by.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.textContent : ''; }).join(' '));
      if (t) return t;
    }
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels[0] && clean(el.labels[0].textContent)) return clean(el.labels[0].textContent);
      if (tag === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && clean(el.value)) return clean(el.value);
      if (el.placeholder && clean(el.placeholder)) return clean(el.placeholder);
      return clean(el.name || el.id || el.type || tag.toLowerCase());
    }
    var text = clean(el.innerText || el.textContent);
    if (text) return text;
    var img = el.querySelector('img[alt]');
    if (img && clean(img.getAttribute('alt'))) return clean(img.getAttribute('alt'));
    return clean(el.getAttribute('title') || el.getAttribute('name') || '');
  }
  function roleOf(el) {
    var role = el.getAttribute('role');
    if (role) return role;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return 'input:' + ((el.type || 'text').toLowerCase());
    if (tag === 'select' || tag === 'textarea') return tag;
    if (tag === 'summary' || tag === 'button') return 'button';
    return el.isContentEditable ? 'textbox' : 'element';
  }
  function secret(el) {
    if (el.tagName !== 'INPUT') return false;
    var t = (el.type || '').toLowerCase();
    if (t === 'password') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac)) return true;
    var id = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
    return /pass(word|wd|code)?\b|\bpin\b|otp|cvv|cvc|card.?num/.test(id);
  }
  function search(el) {
    if ((el.getAttribute('role') || '') === 'searchbox' || (el.type || '').toLowerCase() === 'search') return true;
    var words = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    return el.name === 'q' || /search|query|find/.test(words);
  }
  function info(el, ref) {
    var it = { ref: ref, role: roleOf(el), label: labelOf(el) };
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      it.kind = tag === 'TEXTAREA' ? 'textarea' : (el.type || 'text').toLowerCase();
      if (secret(el)) it.secret = true;
      else if (/^(checkbox|radio)$/.test(it.kind)) it.checked = !!el.checked;
      else if (el.value) it.value = clean(el.value, 60);
      if (search(el)) it.search = true;
      if (el.form) it.form = true;
      if (it.kind === 'file') it.file = true;
      if (tag === 'INPUT' && /^(submit|image)$/.test(it.kind)) it.submits = true;
    } else if (tag === 'SELECT') {
      var o = el.selectedOptions && el.selectedOptions[0];
      it.value = clean(o ? o.textContent : '', 40);
      it.options = Array.prototype.slice.call(el.options, 0, 30).map(function (x) { return clean(x.textContent, 30); });
    } else if (el.isContentEditable) {
      it.kind = 'editable';
    }
    if (tag === 'BUTTON') {
      var bt = (el.getAttribute('type') || 'submit').toLowerCase();
      if (bt === 'submit' && el.form) it.submits = true;
    }
    var ac = el.getAttribute('aria-checked');
    if (ac) it.checked = ac === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') it.disabled = true;
    var ex = el.getAttribute('aria-expanded');
    if (ex) it.expanded = ex === 'true';
    if (tag === 'A' && el.href) it.href = String(el.href).slice(0, 300);
    return it;
  }
  function scroller(start) {
    for (var el = start; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  }
  function where(el) {
    if (el) return { top: Math.round(el.scrollTop), max: Math.max(0, Math.round(el.scrollHeight - el.clientHeight)) };
    var se = document.scrollingElement || document.documentElement;
    return { top: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
  }
  function words(cap) {
    var parts = [], size = 0, last = '';
    if (!document.body) return '';
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      var p = n.parentElement;
      if (!p || !n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (p.closest('script,style,noscript,template,[aria-hidden=true],[inert]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    } });
    var range = document.createRange();
    for (var n = walker.nextNode(); n && size < cap; n = walker.nextNode()) {
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !inView(r)) continue;
      var t = clean(n.nodeValue, 200);
      if (t === last) continue;
      last = t;
      parts.push(t);
      size += t.length + 1;
    }
    return parts.join(' ').slice(0, cap);
  }
  function look(all, cap, textCap) {
    S.refs = {};
    S.n = 0;
    var items = [], more = 0, list = document.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!shown(el)) continue;
      var r = el.getBoundingClientRect();
      if (!all && (!inView(r) || !reach(el, r))) continue;
      if (items.length >= cap) { more++; continue; }
      var ref = 'b' + (++S.n);
      S.refs[ref] = keep(el);
      items.push(info(el, ref));
    }
    return { url: location.href, title: document.title, items: items, more: more, text: words(textCap), scroll: where(null), w: innerWidth, h: innerHeight };
  }
  function point(el, ref) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var r = el.getBoundingClientRect();
    var x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    var h = hitAt(x, y);
    var ok = !!h && (h === el || el.contains(h) || h.contains(el));
    var vv = window.visualViewport;
    var s = vv ? vv.scale : 1, ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
    var d = window.devicePixelRatio || 1;
    return { ok: ok, x: x, y: y, px: (x - ox) * s * d, py: (y - oy) * s * d, covered: ok ? '' : (h ? roleOf(h) + ' "' + labelOf(h).slice(0, 40) + '"' : 'something'), item: info(el, ref) };
  }
  var op = a && a.op;
  if (op === 'look') return look(a.all === true, Math.max(1, Math.min(300, a.cap || 70)), Math.max(200, Math.min(6000, a.textCap || 1400)));
  if (op === 'focused') {
    var f = document.activeElement;
    return f && f !== document.body ? info(f, '') : null;
  }
  if (op === 'scroll') {
    var base = a.ref ? get(a.ref) : null;
    if (a.ref && !base) return { gone: true };
    var box = base ? scroller(base) : null;
    var now = where(box);
    var step = a.amount > 0 ? a.amount : Math.round(innerHeight * 0.8);
    var to = a.direction === 'top' ? 0 : a.direction === 'bottom' ? now.max : a.direction === 'up' ? Math.max(0, now.top - step) : Math.min(now.max, now.top + step);
    if (box) box.scrollTo({ top: to, behavior: 'instant' });
    else window.scrollTo({ top: to, behavior: 'instant' });
    return where(box);
  }
  var el = get(a && a.ref);
  if (!el) return { gone: true, ok: false, x: 0, y: 0, px: 0, py: 0 };
  if (op === 'point') return point(el, a.ref);
  if (op === 'focus') {
    el.focus({ preventScroll: false });
    if (a.clear) {
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) document.execCommand('selectAll');
    }
    return { ok: document.activeElement === el || el.contains(document.activeElement) };
  }
  if (op === 'insert') {
    if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
    var done = document.execCommand('insertText', false, String(a.text || ''));
    if (!done && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      var proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, (a.clear ? '' : el.value) + String(a.text || ''));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      done = true;
    }
    return { ok: !!done };
  }
  if (op === 'choose') {
    if (el.tagName !== 'SELECT') return { ok: false };
    var want = String(a.text || '').toLowerCase();
    var opt = Array.prototype.find.call(el.options, function (x) { return x.value === a.text || clean(x.textContent, 80).toLowerCase() === want; });
    if (!opt) return { ok: false, options: Array.prototype.map.call(el.options, function (x) { return clean(x.textContent, 30); }) };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  return { ok: false };
})`

/** The call: the script applied to its arguments (a JSON object). */
export const lookCall = (args: Record<string, unknown>) => `${LOOK_SCRIPT}(${JSON.stringify(args)})`

// --- what is Shubham's alone --------------------------------------------------------------------------------------------------------------

/**
 * Words that make a press his alone (order o9d97: "no approvals, sends, payments or deletes without his tap"; order o5dc4: ask before pay / send /
 * delete / install; never sign up or unsubscribe). Matched as whole words in what the element says.
 */
const HUMAN_ONLY_WORDS: [kind: string, re: RegExp][] = [
  ['an approval', /\b(approve|approval|accept|allow|authori[sz]e|confirm|grant|consent|agree)\b/i],
  ['a send', /\b(send|submit|post|publish|reply|forward|share|invite|deploy|merge|release)\b/i],
  ['a payment', /\b(pay|payment|buy|purchase|order|checkout|check out|subscribe|donate|transfer|withdraw|deposit|billing|upgrade)\b/i],
  ['a delete', /\b(delete|remove|erase|destroy|drop|discard|trash|wipe|purge|reset|revoke|deactivate|terminate|uninstall)\b/i],
  ['an install', /\b(install|download)\b/i],
  ['a sign-up', /\b(sign ?up|register|create account|unsubscribe)\b/i],
]

/** Why pressing this is his alone (a few words), or null when the Assistant may press it. */
export function humanOnlyWhy(it: Pick<LookItem, 'label' | 'value' | 'submits' | 'file' | 'href'>): string | null {
  if (it.file) return 'an upload'
  const said = `${it.label ?? ''} ${it.value ?? ''}`
  for (const [kind, re] of HUMAN_ONLY_WORDS) if (re.test(said)) return kind
  if (it.submits) return 'a send (it sends its form)'
  return null
}

/** A link the Assistant may follow: one that stays on his tailnet (or does not leave the page). Null: it may; else why not. */
export function linkRefusal(href: string | undefined): string | null {
  if (!href) return null
  if (/^javascript:/i.test(href) || href.startsWith('#')) return null
  if (/^(mailto|tel|sms|intent):/i.test(href)) return 'it opens another app'
  return agentMayOpen(href) ? null : 'it leads to a public site'
}

/**
 * Why the Assistant may not press (or type into) what `ref` points at now: gone, his alone, disabled or covered. Null: it may. `status` says which
 * kind of no it is (403: his alone; 409: the page changed or something is in the way).
 */
export function pointRefusal(p: LookPoint | null | undefined, ref: string, what: 'press' | 'type'): { status: 403 | 409; message: string } | null {
  if (!p || p.gone || !p.item) return { status: 409, message: `${ref} is not on the page any more: the page changed; read the screen again (ui_screen).` }
  const it = p.item
  if (it.secret) return { status: 403, message: refuseWords(ref, 'a password or code field') }
  if (what === 'press') {
    const why = humanOnlyWhy(it) ?? linkRefusal(it.href)
    if (why) return { status: 403, message: refuseWords(ref, why) }
    if (it.disabled) return { status: 409, message: `${ref} is disabled.` }
  } else if (it.file) return { status: 403, message: refuseWords(ref, 'an upload') }
  if (!p.ok) return { status: 409, message: `${ref} is covered by ${p.covered || 'something'}: close or move what is on top first.` }
  return null
}

/** Whether `item` takes typing (a text field, a text area or an editable element; never a button, a box to tick or a file picker). */
export const typeable = (it: Pick<LookItem, 'kind'>) => it.kind !== undefined && !/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(it.kind)

/** What the Assistant is told when a press, a field or a key is his alone (it must not try another way). */
export function refuseWords(ref: string, why: string): string {
  return `${ref} is human-only in the Browser (${why}): only Shubham's own tap counts. Do not try another way; tell him what to tap himself.`
}

/**
 * Whether the Assistant may press `key` with `focused` focused in the tab. Enter sends a form (or a chat box's message), Space presses a button:
 * Enter only in a search field, Space only while typing in a field; moving keys (Tab, Escape, arrows, Page Up / Down, Home, End) and the deleting
 * keys of a field (Backspace, Delete) always. Null: it may; else why not.
 */
export function keyRefusal(key: string, focused: Pick<LookItem, 'search' | 'kind' | 'secret' | 'role'> | null): string | null {
  if (focused?.secret) return 'a password or code field'
  if (key === 'Enter') return focused?.search ? null : 'Enter here would send or confirm something (only a search field takes it from you)'
  if (key === ' ' || key === 'Space') return focused?.kind && focused.kind !== 'checkbox' && focused.kind !== 'radio' ? null : 'Space would press what is focused'
  return /^(Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Backspace|Delete)$/.test(key) ? null : `the ${key} key is not one you press in the Browser`
}

// --- the screen, as the Assistant reads it ---------------------------------------------------------------------------------------------------

/** One element's line: [b3] button "Save" (disabled) → address; what is his alone, said. */
export function lookLine(it: LookItem): string {
  let line = `[${it.ref}] ${it.role} "${it.label}"`
  if (it.secret) return `${line} (a password or code field: never read or typed by you; only Shubham fills it)`
  if (it.checked !== undefined) line += it.checked ? ' (checked)' : ' (unchecked)'
  if (it.value) line += ` = "${it.value}"`
  if (it.options?.length) line += ` (options: ${it.options.slice(0, 12).join(', ')}${it.options.length > 12 ? ', …' : ''})`
  if (it.expanded !== undefined) line += it.expanded ? ' (open)' : ' (closed)'
  if (it.disabled) line += ' (disabled)'
  const why = humanOnlyWhy(it)
  if (why) line += ` (human-only: ${why}; Shubham taps this himself)`
  else if (it.href) {
    const no = linkRefusal(it.href)
    line += no ? ` (Shubham opens this himself: ${no})` : ''
  }
  if (it.href && !/^javascript:/i.test(it.href)) line += ` → ${it.href.slice(0, 90)}`
  return line
}

/** Which tab the Assistant acts on, as he reads it: "PC tab 2" / "Phone tab 1". */
export const tabName = (side: 'pc' | 'phone', index: number) => `${side === 'pc' ? 'PC' : 'Phone'} tab ${index + 1}`

/** The Browser part of ui_screen: which tab, its page (private), what to press or fill there (b-refs) and its words. */
export function lookScreen(r: LookResult, o: { side: 'pc' | 'phone'; index: number; count: number }): string {
  const pos = r.scroll.max > 4 ? `scrolled ${r.scroll.top} of ${r.scroll.max}px` : 'fits on screen'
  return [
    `Acting on: ${tabName(o.side, o.index)} of ${o.count} (${o.side === 'pc' ? 'the browser on the Server' : "this phone's own browser"}) — "${r.title}" — ${r.url}`,
    BROWSER_PRIVATE_NOTE,
    `Its page: ${r.w}x${r.h}, ${pos}. b-refs act inside this tab: ui_control click / type / key / scroll with them; ui_control browse (url) opens a tailnet address in it.`,
    '',
    'In the tab, you can press / fill:',
    ...(r.items.length ? r.items.map(lookLine) : ['(nothing)']),
    ...(r.more ? [`… ${r.more} more not listed: scroll, or ask with all=true`] : []),
    '',
    `Words on its screen: ${r.text || '(none)'}`,
  ].join('\n')
}
