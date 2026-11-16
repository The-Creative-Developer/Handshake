import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/spline-sans-mono';
import './style.css';

import { h } from './dom';
import { Inspector } from './inspector';
import { WireLog } from './log';
import { formatClock, formatDuration } from './protocol';
import { toyInternet, type Input } from './scenario';
import { Scene, type Selection } from './scene';
import { Session } from './session';
import { TimelineStrip } from './timeline';

const SPEEDS = [0.25, 0.5, 1, 2, 4];

// ------------------------------------------------------------------- shell ----

const playButton = h('button', { type: 'button', class: 'transport primary', title: 'Play or pause (space)' });
const backButton = h('button', { type: 'button', class: 'transport', title: 'Back to the previous thing that happened (←)' }, '◂ Step');
const stepButton = h('button', { type: 'button', class: 'transport', title: 'On to the next thing that happens (→)' }, 'Step ▸');
const latestButton = h('button', { type: 'button', class: 'transport', title: 'Jump to the furthest point reached and carry on' }, 'Latest');
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
const stripCanvas = h('canvas', { 'aria-label': 'Timeline. Drag to move through time.' });
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
      backButton,
      stepButton,
      latestButton,
      speedSelect,
      h('label', { class: 'check', title: 'Jump over stretches where nothing is happening' }, skipToggle, 'Skip silence'),
      restartButton,
    ),
    h('div', { class: 'clock' }, clockStatus, clockValue),
  ),
  h('main', { class: 'map' }, canvas, tryList),
  h('section', { class: 'strip' }, stripCanvas),
  h(
    'section',
    { class: 'log' },
    h('header', null, h('h2', null, 'Wire log'), h('label', { class: 'check' }, verboseToggle, 'Every step')),
    logList,
  ),
  inspectorRoot,
);

// ----------------------------------------------------------------- session ----

/** Everything on screen that belongs to one sitting. Restarting replaces the lot. */
interface Stage {
  session: Session;
  scene: Scene;
  inspector: Inspector;
  log: WireLog;
}

function start(): Stage {
  const peerOf = (device: string, iface: string) => {
    const nic = session.sim.devices.get(device)?.nics.find((n) => n.name === iface);
    const link = nic?.link;
    return link ? (link.a === nic ? link.b : link.a).owner.id : undefined;
  };
  const select = (selection: Selection) => {
    scene.selection = selection;
    inspector.show(selection);
  };
  const perform = (input: Input) => session.perform(input, performance.now());

  const log = new WireLog(logList, peerOf, (frame) => select({ kind: 'frame', frame }));
  // A cable is a different object after history is re-run, so remember which one was selected by position.
  let selectedLink = -1;

  const session: Session = new Session(toyInternet, {
    onEvent: (event) => log.add(event),
    onNote: (note) => log.note(note.t, note.device, note.text),
    onRebuild: (phase) => {
      if (phase === 'start') {
        const selection = scene.selection;
        selectedLink = selection?.kind === 'link' ? session.sim.links.indexOf(selection.link) : -1;
        log.beginLoad();
        return;
      }
      log.endLoad();
      scene.attach(session.scenario, session.model);
      inspector.rebind(session.scenario);
      // Carry the selection over to the rebuilt network, where it still exists.
      const selection = scene.selection;
      let carried: Selection = selection;
      if (selection?.kind === 'link') {
        const link = session.sim.links[selectedLink];
        carried = link ? { kind: 'link', link } : null;
      } else if (selection?.kind === 'frame') {
        carried = { kind: 'frame', frame: session.currentFrame(selection.frame) ?? selection.frame };
      }
      select(carried);
    },
  });

  log.setVerbose(verboseToggle.checked);
  session.speed = Number(speedSelect.value);
  session.skipSilence = skipToggle.checked;
  const scene = new Scene(canvas, session.scenario, session.model, select, (a, b) => session.sameFrame(a, b));
  const inspector = new Inspector(inspectorRoot, session.scenario, perform);

  tryList.replaceChildren(
    h('span', { class: 'label' }, 'Try'),
    ...session.scenario.actions.map((action, index) =>
      h('button', { type: 'button', onclick: () => perform({ kind: 'action', index }) }, action.label),
    ),
  );
  scene.resize();
  return { session, scene, inspector, log };
}

let stage = start();
const strip = new TimelineStrip(stripCanvas, () => stage.session);

// ---------------------------------------------------------------- controls ----

playButton.addEventListener('click', () => (stage.session.playing = !stage.session.playing));
backButton.addEventListener('click', () => stage.session.stepBack(performance.now()));
stepButton.addEventListener('click', () => stage.session.step(performance.now()));
latestButton.addEventListener('click', () => {
  stage.session.seek(stage.session.head, performance.now());
  stage.session.playing = true;
});
restartButton.addEventListener('click', () => {
  stage.scene.dispose();
  stage = start();
  stage.session.perform({ kind: 'action', index: 0 }, performance.now());
});
speedSelect.addEventListener('change', () => (stage.session.speed = Number(speedSelect.value)));
skipToggle.addEventListener('change', () => (stage.session.skipSilence = skipToggle.checked));
verboseToggle.addEventListener('change', () => stage.log.setVerbose(verboseToggle.checked));

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(target.tagName)) return;
  const { session } = stage;
  if (event.key === ' ') {
    event.preventDefault();
    session.playing = !session.playing;
  } else if (event.key === 'ArrowRight') {
    session.step(performance.now());
  } else if (event.key === 'ArrowLeft') {
    session.stepBack(performance.now());
  } else if (event.key === 'Escape') {
    stage.scene.selection = null;
    stage.inspector.show(null);
  }
});

// A button clicked with the mouse gives up focus, so that space goes back to
// meaning play or pause. A button reached with the keyboard keeps it.
document.addEventListener('click', (event) => {
  if (event.detail > 0) (event.target as HTMLElement | null)?.closest('button')?.blur();
});

new ResizeObserver(() => stage.scene.resize()).observe(canvas);
new ResizeObserver(() => strip.resize()).observe(stripCanvas);

// -------------------------------------------------------------------- loop ----

let last = performance.now();
let lastRefresh = 0;

function status(session: Session, now: number): string {
  if (session.lastSkip && now - session.lastSkip.atMs < 2600) {
    return `skipped ${formatDuration(session.lastSkip.us)} of silence`;
  }
  if (session.inPast) return session.playing ? 'replaying' : 'paused in the past';
  if (!session.playing) return 'paused';
  return session.idle ? 'quiet: nothing in flight' : '';
}

function tick(now: number): void {
  const { session, scene, inspector } = stage;
  // Dragging along the timeline asks for many moments; act on the latest once per frame.
  const wanted = strip.takeSeek();
  if (wanted !== null) session.seek(wanted, now);
  session.frame(now - last, now);
  last = now;
  scene.draw(session.clock, now);
  strip.draw();

  clockValue.textContent = formatClock(session.clock);
  clockStatus.textContent = status(session, now);
  playButton.textContent = session.playing ? 'Pause' : 'Play';
  latestButton.disabled = !session.inPast;
  backButton.disabled = session.clock === 0;

  // The tables in the inspector change as packets land, but not sixty times a second.
  if (now - lastRefresh > 200) {
    inspector.refresh();
    lastRefresh = now;
  }
  requestAnimationFrame(tick);
}

// Canvas text is measured with the page's fonts, so wait for them before the first frame.
void document.fonts.ready.then(() => {
  stage.scene.resize();
  strip.resize();
  stage.session.perform({ kind: 'action', index: 0 }, performance.now());
  last = performance.now();
  requestAnimationFrame(tick);
});
