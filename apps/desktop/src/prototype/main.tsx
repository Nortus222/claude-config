// PROTOTYPE — three app-shell directions for the nortuscc desktop UI, switchable via
// ?variant=A|B|C, with ?screen=<key> kept across switches so the same screen can be compared.
// Run: npm run prototype. Not part of the production build (vite builds index.html only).
import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { screens, type Screen } from './data.ts';
import { VariantA, name as nameA } from './VariantA.tsx';
import { VariantB, name as nameB } from './VariantB.tsx';
import { VariantC, name as nameC } from './VariantC.tsx';
import './switcher.css';

export type VariantProps = { screen: Screen; go: (screen: Screen) => void };

const variants = [
  { key: 'A', name: nameA, Component: VariantA },
  { key: 'B', name: nameB, Component: VariantB },
  { key: 'C', name: nameC, Component: VariantC },
];

const read = () => {
  const params = new URLSearchParams(location.search);
  const variant = variants.find((v) => v.key === params.get('variant'))?.key ?? 'A';
  const screen = (screens.find((s) => s.key === params.get('screen'))?.key ?? 'dashboard') as Screen;
  return { variant, screen };
};

function Prototype() {
  const [state, setState] = useState(read);
  const update = useCallback((next: Partial<ReturnType<typeof read>>) => {
    setState((prev) => {
      const merged = { ...prev, ...next };
      history.replaceState(null, '', `?variant=${merged.variant}&screen=${merged.screen}`);
      return merged;
    });
  }, []);
  const index = variants.findIndex((v) => v.key === state.variant);
  const cycle = useCallback(
    (step: number) => update({ variant: variants[(index + step + variants.length) % variants.length]!.key }),
    [index, update],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);
  const current = variants[index]!;
  const { Component } = current;
  return (
    <>
      <Component key={current.key} screen={state.screen} go={(screen) => update({ screen })} />
      {import.meta.env.DEV && (
        <div className="proto-switcher" role="toolbar" aria-label="Prototype variant">
          <button onClick={() => cycle(-1)} aria-label="Previous variant">←</button>
          <span>
            <b>{current.key}</b> {current.name}
          </span>
          <button onClick={() => cycle(1)} aria-label="Next variant">→</button>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Prototype />);
