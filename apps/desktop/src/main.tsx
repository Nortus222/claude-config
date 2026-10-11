import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { MachineController } from './controller.ts';
import { AccountController } from './account-controller.ts';
import { SetupController } from './setup-controller.ts';
import { nativeAvailable, nativeBridge } from './bridge.ts';
import { ReviewView } from './review-view.tsx';
import { OverviewView, ResolvedView, SettingsView, SetupView, ShellView, screenForReview, type Screen } from './views.tsx';
import './style.css';

function App() {
  const [controllers] = useState(() => {
    const bridge = nativeAvailable() ? nativeBridge : null;
    const machine = new MachineController(bridge);
    return { machine, account: new AccountController(bridge, machine), setup: new SetupController(bridge, machine) };
  });
  const { machine, account, setup } = controllers;
  const state = useSyncExternalStore(machine.subscribe, machine.snapshot);
  const accountState = useSyncExternalStore(account.subscribe, account.snapshot);
  const setupState = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const [screen, setScreen] = useState<Screen>('overview');
  const reviewTarget = useRef<HTMLHeadingElement>(null);
  const reviewSeen = useRef(0);
  const focusReview = useRef(false);
  useEffect(() => {
    void setup.check();
    return () => { account.dispose(); setup.dispose(); machine.dispose(); };
  }, [machine, account, setup]);
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

  if (setupState.phase !== 'ready' && setupState.phase !== 'browser') return <SetupView state={setupState} controller={setup} />;
  return <ShellView screen={screen} navigate={setScreen}>
    {screen === 'overview' ? <OverviewView state={state} navigate={setScreen} /> : null}
    {screen === 'review' ? <ReviewView state={state} controller={machine} reviewTarget={reviewTarget} /> : null}
    {screen === 'resolved' ? <ResolvedView state={state} controller={machine} /> : null}
    {screen === 'settings' ? <SettingsView machine={state} state={accountState} controller={account} machineController={machine} /> : null}
  </ShellView>;
}

createRoot(document.getElementById('root')!).render(<App />);
