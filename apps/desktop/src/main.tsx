import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MachineController } from './controller.ts';
import { AccountController } from './account-controller.ts';
import { SetupController } from './setup-controller.ts';
import { UpdateController } from './update-controller.ts';
import { UpdateView } from './update-view.tsx';
import { nativeAvailable, nativeBridge, nativeUpdateBridge } from './bridge.ts';
import { ReviewView } from './review-view.tsx';
import { OverviewView, ResolvedView, SettingsView, SetupView, ShellView, screenForReview, type Screen } from './views.tsx';
import './style.css';

function App() {
  const [controllers] = useState(() => {
    const bridge = nativeAvailable() ? nativeBridge : null;
    const machine = new MachineController(bridge);
    return { machine, account: new AccountController(bridge, machine), setup: new SetupController(bridge, machine), updates: new UpdateController(bridge ? nativeUpdateBridge : null) };
  });
  const { machine, account, setup, updates } = controllers;
  const state = useSyncExternalStore(machine.subscribe, machine.snapshot);
  const accountState = useSyncExternalStore(account.subscribe, account.snapshot);
  const setupState = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const updateState = useSyncExternalStore(updates.subscribe, updates.snapshot);
  const [screen, setScreen] = useState<Screen>('overview');
  const reviewTarget = useRef<HTMLHeadingElement>(null);
  const reviewSeen = useRef(0);
  const focusReview = useRef(false);
  useEffect(() => {
    void updates.start();
    void setup.check();
    return () => { account.dispose(); setup.dispose(); machine.dispose(); updates.dispose(); };
  }, [machine, account, setup, updates]);
  useEffect(() => {
    if (state.connection === 'connected') void account.refresh();
  }, [account, state.connection, state.session]);
  useEffect(() => {
    if (state.reviewRequested <= reviewSeen.current) return;
    const previous = reviewSeen.current;
    focusReview.current = true;
    setScreen((current) => screenForReview(current, previous, state.reviewRequested));
    reviewSeen.current = state.reviewRequested;
  }, [state.reviewRequested]);
  useEffect(() => {
    if (screen !== 'review' || !focusReview.current || !reviewTarget.current) return;
    reviewTarget.current.focus();
    reviewTarget.current.scrollIntoView({ block: 'start' });
    focusReview.current = false;
  }, [screen, state.reviewRequested]);

  if (setupState.phase !== 'ready' && setupState.phase !== 'browser') return <>
    <SetupView state={setupState} controller={setup} />
    <div className="onboarding first-run-updates"><UpdateView state={updateState} controller={updates} /></div>
  </>;
  return <ShellView screen={screen} navigate={setScreen}>
    {screen === 'overview' ? <OverviewView state={state} navigate={setScreen} /> : null}
    {screen === 'review' ? <ReviewView state={state} controller={machine} reviewTarget={reviewTarget} /> : null}
    {screen === 'resolved' ? <ResolvedView state={state} controller={machine} /> : null}
    {screen === 'settings' ? <>
      <SettingsView machine={state} state={accountState} controller={account} machineController={machine} />
      <UpdateView state={updateState} controller={updates} />
    </> : null}
  </ShellView>;
}

createRoot(document.getElementById('root')!).render(<App />);
