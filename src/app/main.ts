import { describeEvent, type TraceEvent } from '../engine';
import { runDemo } from './demo';
import './style.css';

// Placeholder front end: it runs a fixed scenario and lists the trace, to show
// the engine working in a browser. The canvas renderer will replace it.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function formatTime(us: number): string {
  return `${(us / 1000).toFixed(1)} ms`;
}

function where(event: TraceEvent): string {
  return 'iface' in event ? `${event.device}:${event.iface}` : event.device;
}

const { sim, steps } = runDemo();
const app = document.querySelector<HTMLElement>('#app')!;

const header = el('header');
header.append(el('h1', '', 'Handshake'), el('p', 'lede', 'Simulation engine demo: a laptop finds a web server by name across two routers, then pings it.'));

const results = el('ul', 'results');
for (const { label, outcome, ok } of steps) {
  const item = el('li');
  item.append(el('span', 'label', label), el('span', ok ? 'outcome ok' : 'outcome other', outcome));
  results.append(item);
}

const table = el('table');
const head = el('tr');
for (const title of ['#', 'Time', 'Where', 'Event', 'Detail']) head.append(el('th', '', title));
table.createTHead().append(head);
const body = table.createTBody();
for (const event of sim.trace) {
  const row = el('tr');
  row.append(el('td', 'num', String(event.seq)), el('td', 'num', formatTime(event.t)), el('td', '', where(event)));
  const kind = el('td');
  kind.append(el('span', `kind ${event.kind}`, event.kind));
  row.append(kind, el('td', '', describeEvent(event)));
  body.append(row);
}

const scroller = el('div', 'trace');
scroller.append(table);
app.append(header, results, el('h2', '', `Trace (${sim.trace.length} events)`), scroller);
