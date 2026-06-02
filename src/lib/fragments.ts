import type { Fragment } from '../types';

const EPS = 1e-4;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `frag_${Date.now().toString(36)}_${counter}`;
}

export function createFragment(srcStart: number, srcEnd: number): Fragment {
  return { id: nextId(), srcStart, srcEnd };
}

export function fragmentDuration(f: Fragment): number {
  return Math.max(0, f.srcEnd - f.srcStart);
}

export function totalOutputDuration(fragments: Fragment[]): number {
  let total = 0;
  for (const f of fragments) total += fragmentDuration(f);
  return total;
}

export function fragmentOutputStart(fragments: Fragment[], idx: number): number {
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += fragmentDuration(fragments[i]!);
  return acc;
}

export interface OutputMapping {
  index: number;
  fragment: Fragment;
  srcTime: number;
  fragOutputStart: number;
}

export function outputToSource(
  fragments: Fragment[],
  outputTime: number,
): OutputMapping | null {
  if (!fragments.length) return null;
  const t = Math.max(0, outputTime);
  let acc = 0;
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i]!;
    const d = fragmentDuration(f);
    // End-EXCLUSIVE: an output time exactly on a fragment boundary resolves to
    // the LATER fragment (the one playback is entering). Critical when a body
    // chunk resumes after a mid-roll card whose anchor sits on a fragment edge —
    // otherwise the lookup returns the prior fragment and playback stalls. The
    // last fragment is inclusive so the very end still maps to it.
    if (t < acc + d || i === fragments.length - 1) {
      const offset = Math.min(d, Math.max(0, t - acc));
      return {
        index: i,
        fragment: f,
        srcTime: f.srcStart + offset,
        fragOutputStart: acc,
      };
    }
    acc += d;
  }
  return null;
}

export function sourceToOutput(
  fragments: Fragment[],
  srcTime: number,
): { outputTime: number; index: number } | null {
  let acc = 0;
  for (let i = 0; i < fragments.length; i++) {
    const f = fragments[i]!;
    if (srcTime >= f.srcStart - EPS && srcTime <= f.srcEnd + EPS) {
      return {
        outputTime: acc + Math.max(0, srcTime - f.srcStart),
        index: i,
      };
    }
    acc += fragmentDuration(f);
  }
  return null;
}

export function cutFragmentAtSource(
  fragments: Fragment[],
  index: number,
  srcTime: number,
  minDuration = 0.05,
): Fragment[] {
  const f = fragments[index];
  if (!f) return fragments;
  if (srcTime <= f.srcStart + minDuration) return fragments;
  if (srcTime >= f.srcEnd - minDuration) return fragments;
  const left = createFragment(f.srcStart, srcTime);
  const right = createFragment(srcTime, f.srcEnd);
  const next = fragments.slice();
  next.splice(index, 1, left, right);
  return next;
}

export function removeFragmentAt(fragments: Fragment[], index: number): Fragment[] {
  if (index < 0 || index >= fragments.length) return fragments;
  if (fragments.length <= 1) return fragments;
  const next = fragments.slice();
  next.splice(index, 1);
  return next;
}

export function reorderFragment(
  fragments: Fragment[],
  fromIndex: number,
  toIndex: number,
): Fragment[] {
  if (fromIndex === toIndex) return fragments;
  if (fromIndex < 0 || fromIndex >= fragments.length) return fragments;
  const next = fragments.slice();
  const [item] = next.splice(fromIndex, 1);
  if (!item) return fragments;
  const clamped = Math.max(0, Math.min(next.length, toIndex));
  next.splice(clamped, 0, item);
  return next;
}

export function setFragmentEdge(
  fragments: Fragment[],
  index: number,
  edge: 'start' | 'end',
  srcTime: number,
  minDuration = 0.05,
): Fragment[] {
  const f = fragments[index];
  if (!f) return fragments;
  const next = fragments.slice();
  if (edge === 'start') {
    const ns = Math.max(0, Math.min(f.srcEnd - minDuration, srcTime));
    next[index] = { ...f, srcStart: ns };
  } else {
    const ne = Math.max(f.srcStart + minDuration, srcTime);
    next[index] = { ...f, srcEnd: ne };
  }
  return next;
}
