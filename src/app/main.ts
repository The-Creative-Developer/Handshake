import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/spline-sans-mono';
import './style.css';

import type { EthernetFrame, TraceEvent } from '../engine';
import { h } from './dom';
import { Inspector } from './inspector';
import { WireLog } from './log';
import { Model } from './model';
import { Player } from './player';
import { formatClock, formatDuration } from './protocol';
import { toyInternet, type Note, type Scenario } from './scenario';
import { Scene, type Selection } from './scene';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Everything that belongs to one run of a scenario. Restarting replaces the lot. */
interface Session {
  scenario: Scenario;
  model: Model;
  player: Player;
  scene: Scene;
  inspector: Inspector;
  log: WireLog;
}

// ------------------------------------------------------------------- shell ----

const playButton = h('button', { type: 'button', class: 'transport primary', title: 'Play or pause (space)' });
const stepButton = h('button', { type: 'button', class: 'transport', title: 'Advance to the next thing that happens (→)' }, 'Step');
const restartButton = h('button', { type: 'button', class: 'transport', title: 'Start the scenario again' }, 'Restart');
const speedSelect = h(
  'select',
  { class: 'transport', 'aria-label': 'Playback speed', title: 'Playback speed' },
  ...SPEEDS.map((speed) => h('option', { value: String(speed), selected: speed === 1 }, `${speed}×`)),
);
const skipToggle = h('input', { type: 'checkbox', checked: true });
const verboseToggle = h('input', { type: 'checkbox' });

const clockValue = h('span', { class: 'value' }, formatClock(0));
const clockStatus = h('span', { class: 'status' }, '');
const canvas = h('canvas', { 'aria-label': 'Network map' });
const tryList = h('div', { class: 'try' });
const logList = h('ol', { class: 'rows' });
const inspectorRoot = h('aside', { class: 'inspector' });

document.querySelector('#app')!.append(
  h(
    'header',
    { class: 'bar' },
    h('div', { class: 'brand' }, h('span', { class: 'wordmark' }, 'Handshake'), h('span', { class: 'tagline' }, 'a playable internet')),
    h(
      'div',
      { class: 'controls' },
      playButton,
      stepButton,
      speedSelect,
      h('label', { class: 'check', title: 'Jump over stretches where nothing is happening' }, skipToggle, 'Skip silence'),
      restartButton,
    ),
    h('div', { class: 'clock' }, clockStatus, clockValue),
  ),
  h('main', { class: 'map' }, canvas, tryList),
  h(
    'section',
    { class: 'log' },
    h('header', null, h('h2', null, 'Wire log'), h('label', { class: 'check' }, verboseToggle, 'Every step')),
    logList,
  ),
  inspectorRoot,
);

// ----------------------------------------------------------------- session ----

function start(): Session {
  const scenario = toyInternet();
  const model = new Model(scenario.sim);

  const note: Note = (device, text) => log.note(scenario.sim.now, device, text);
  const peerOf = (device: string, iface: string) => {
    const nic = scenario.sim.devices.get(device)?.nics.find((n) => n.name === iface);
    const link = nic?.link;
    return link ? (link.a === nic ? link.b : link.a).owner.id : undefined;
  };
  const select = (selection: Selection) => {
    scene.selection = selection;
    inspector.show(selection);
  };

  const log = new WireLog(logList, peerOf, (frame: EthernetFrame) => select({ kind: 'frame', frame }));
  log.setVerbose(verboseToggle.checked);
  const player = new Player(scenario.sim, model, (event: TraceEvent) => log.add(event));
  player.speed = Number(speedSelect.value);
  player.skipSilence = skipToggle.checked;
  const scene = new Scene(canvas, scenario, model, select);
  const inspector = new Inspector(inspectorRoot, scenario, note, () => (player.playing = true));

  tryList.replaceChildren(
    h('span', { class: 'label' }, 'Try'),
    ...scenario.actions.map((action) =>
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            action.run(note);
            player.playing = true; // something was just set in motion: let it be seen
          },
        },
        action.label,
      ),
    ),
  );
  scene.resize();
  return { scenario, model, player, scene, inspector, log };
}

let session = start();

// ---------------------------------------------------------------- controls ----

playButton.addEventListener('click', () => (session.player.playing = !session.player.playing));
stepButton.addEventListener('click', () => {
  session.player.playing = false;
  session.player.step(performance.now());
});
restartButton.addEventListener('click', () => {
  session.scene.dispose();
  session = start();
  session.scenario.actions[0]?.run((device, text) => session.log.note(session.scenario.sim.now, device, text));
});
speedSelect.addEventListener('change', () => (session.player.speed = Number(speedSelect.value)));
skipToggle.addEventListener('change', () => (session.player.skipSilence = skipToggle.checked));
verboseToggle.addEventListener('change', () => session.log.setVerbose(verboseToggle.checked));

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(target.tagName)) return;
  if (event.key === ' ') {
    event.preventDefault();
    session.player.playing = !session.player.playing;
  } else if (event.key === 'ArrowRight') {
    session.player.playing = false;
    session.player.step(performance.now());
  } else if (event.key === 'Escape') {
    session.scene.selection = null;
    session.inspector.show(null);
  }
});

// A button clicked with the mouse gives up focus, so that space goes back to
// meaning play or pause. A button reached with the keyboard keeps it.
document.addEventListener('click', (event) => {
  if (event.detail > 0) (event.target as HTMLElement | null)?.closest('button')?.blur();
});

new ResizeObserver(() => session.scene.resize()).observe(canvas);

// -------------------------------------------------------------------- loop ----

let last = performance.now();
let lastRefresh = 0;

function tick(now: number): void {
  const { player, scene, inspector } = session;
  player.frame(now - last, now);
  last = now;
  scene.draw(player.clock, now);

  clockValue.textContent = formatClock(player.clock);
  const skipped = player.lastSkip && now - player.lastSkip.atMs < 2600 ? player.lastSkip.us : 0;
  clockStatus.textContent = skipped
    ? `skipped ${formatDuration(skipped)} of silence`
    : !player.playing
      ? 'paused'
      : player.idle
        ? 'quiet: nothing in flight'
        : '';
  playButton.textContent = player.playing ? 'Pause' : 'Play';

  // The tables in the inspector change as packets land, but not sixty times a second.
  if (now - lastRefresh > 200) {
    inspector.refresh();
    lastRefresh = now;
  }
  requestAnimationFrame(tick);
}

// Canvas text is measured with the page's fonts, so wait for them before the first frame.
void document.fonts.ready.then(() => {
  session.scene.resize();
  session.scenario.actions[0]?.run((device, text) => session.log.note(session.scenario.sim.now, device, text));
  last = performance.now();
  requestAnimationFrame(tick);
});
