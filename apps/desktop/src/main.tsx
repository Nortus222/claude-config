import { AuthorController } from './author-controller.ts';
import { ProfilesView } from './profiles-view.tsx';
import { UpstreamsView } from './upstreams-view.tsx';
import { PublishView } from './publish-view.tsx';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { SkillsController } from './skills-controller.ts';
import { SkillsView } from './skills-view.tsx';
import { MachineController } from './controller.ts';
import { AccountController } from './account-controller.ts';
import { SetupSyncController } from './setup-sync-controller.ts';
import { SetupSyncView } from './setup-sync-view.tsx';
import { SetupController } from './setup-controller.ts';
import { ConnectionsController } from './mcp-connections-controller.ts';
import { ConnectionsView } from './mcp-connections-view.tsx';
import { UpdateController } from './update-controller.ts';
import { UpdateView } from './update-view.tsx';
import { HomeController } from './home-controller.ts';
import { HomeView } from './home-view.tsx';
import { ProfileChoiceView, profileChoiceDue, followApplied } from './profile-choice-view.tsx';
import { DEFAULT_REPO_URL } from '../shared/setup-protocol.ts';
import { nativeAvailable, nativeBridge, nativeUpdateBridge } from './bridge.ts';
import { SettingsView, StartupBoundary, updateAttention, ShellView, screenForReview, followFromSettings, navBadges, type Screen } from './views.tsx';
import './style.css';
import './home.css';
import './changes.css';
import './publish.css';
import './profile-choice.css';

const appMaintenance = (phase: string | undefined) => ['waiting', 'installing', 'restarting', 'recovery'].includes(phase ?? '') ? 'An app update is installing or needs recovery.' : null;
const AUTHOR_SCREENS: ReadonlySet<Screen> = new Set(['profiles', 'upstreams', 'publish']);

function App() {
  const [controllers] = useState(() => {
    const bridge = nativeAvailable() ? nativeBridge : null;
    const machine = new MachineController(bridge);
    const updates = new UpdateController(bridge ? nativeUpdateBridge : null);
    const setupSync = new SetupSyncController(bridge, machine, { maintenance: () => appMaintenance(updates.state.update?.phase) !== null });
    const skills = new SkillsController(bridge, machine, { maintenance: () => appMaintenance(updates.state.update?.phase) });
    const author = new AuthorController(bridge, machine, { maintenance: () => appMaintenance(updates.state.update?.phase) !== null });
    return { machine, skills, author, home: new HomeController(bridge, machine), connections: new ConnectionsController(bridge, machine), account: new AccountController(bridge, machine), setup: new SetupController(bridge, machine), updates, setupSync };
  });
  const { machine, account, setup, updates, connections, setupSync, skills, author, home } = controllers;
  const state = useSyncExternalStore(machine.subscribe, machine.snapshot);
  const authorState = useSyncExternalStore(author.subscribe, author.snapshot);
  const skillsState = useSyncExternalStore(skills.subscribe, skills.snapshot);
  const connectionsState = useSyncExternalStore(connections.subscribe, connections.snapshot);
  const accountState = useSyncExternalStore(account.subscribe, account.snapshot);
  const setupSyncState = useSyncExternalStore(setupSync.subscribe, setupSync.snapshot);
  const homeState = useSyncExternalStore(home.subscribe, home.snapshot);
  const setupState = useSyncExternalStore(setup.subscribe, setup.snapshot);
  const updateState = useSyncExternalStore(updates.subscribe, updates.snapshot);
  const [screen, setScreen] = useState<Screen>('home');
  // Set once the first-run profile choice is made or kept; it is never shown again in this session.
  const [profileSettled, setProfileSettled] = useState(false);
  const choosingProfile = profileChoiceDue(setupState, state, profileSettled);
  const settleProfile = () => { setProfileSettled(true); setScreen('home'); };
  // The controller loads the review and profiles itself once the agent is connected and its first read is done.
  useEffect(() => { if (screen === 'home' || screen === 'changes') setupSync.enter(); else setupSync.leave(); }, [screen, setupSync]);
  useEffect(() => { if (choosingProfile && followApplied(setupSyncState)) settleProfile(); }, [choosingProfile, setupSyncState]);
  useEffect(() => { setupSync.refresh(); }, [setupSync, updateState.update?.phase]);
  useEffect(() => { if (AUTHOR_SCREENS.has(screen)) author.enter(); else author.leave(); }, [author, screen, state.session, state.connection]);
  useEffect(() => { author.refresh(); }, [author, updateState.update?.phase]);
  // Home's runs and drafts also feed the Publish badge, so they are read on every (re)connection too.
  useEffect(() => { if (screen === 'home') void home.refresh(); }, [home, screen]);
  useEffect(() => { if (state.connection === 'connected') void home.refresh(); }, [home, state.connection, state.session]);
  const reviewSeen = useRef(0);
  useEffect(() => {
    if (screen === 'skills') skills.enter();
    return () => { if (screen === 'skills') skills.leave(); };
  }, [skills, screen, state.session, state.connection]);
  useEffect(() => {
    void updates.start();
    void setup.check();
    return () => { author.dispose(); skills.dispose(); account.dispose(); setup.dispose(); setupSync.dispose(); home.dispose(); machine.dispose(); updates.dispose(); connections.dispose(); };
  }, [machine, account, setup, updates, connections, setupSync, skills, author, home]);
  useEffect(() => {
    if (state.connection === 'connected') { void account.refresh(); void connections.refresh(); }
  }, [account, connections, state.connection, state.session]);
  useEffect(() => {
    if (state.reviewRequested <= reviewSeen.current) return;
    const previous = reviewSeen.current;
    setScreen((current) => screenForReview(current, previous, state.reviewRequested, state.status));
    reviewSeen.current = state.reviewRequested;
  }, [state.reviewRequested, state.status]);

  return <StartupBoundary setup={setupState} setupController={setup} machine={state} machineController={machine}
    updatesAttention={updateAttention(updateState)} updates={<UpdateView state={updateState} controller={updates} />}>
    {choosingProfile ? <ProfileChoiceView state={setupSyncState} controller={setupSync} repoUrl={setupState.setup?.defaultRepoUrl ?? DEFAULT_REPO_URL} onDone={settleProfile} /> :
    <ShellView screen={screen} navigate={setScreen} machine={state} badges={navBadges(setupSyncState, homeState, updateState)} onReconnect={() => void machine.restart()} onRecheck={() => void machine.inspect()}>
      {screen === 'home' ? <HomeView machine={state} changes={setupSyncState} home={homeState} update={updateState} navigate={setScreen} controller={home} /> : null}
      {screen === 'changes' ? <SetupSyncView state={setupSyncState} controller={setupSync} onOpenProfiles={() => setScreen('profiles')} repoUrl={setupState.setup?.defaultRepoUrl ?? DEFAULT_REPO_URL} /> : null}
      {screen === 'skills' ? <SkillsView state={skillsState} machine={state} controller={skills} maintenance={appMaintenance(updateState.update?.phase)} onOpenChanges={() => setScreen('changes')} /> : null}
      {screen === 'profiles' ? <ProfilesView state={authorState} controller={author} onOpenPublish={() => setScreen('publish')} /> : null}
      {screen === 'upstreams' ? <UpstreamsView state={authorState} controller={author} onOpenPublish={() => setScreen('publish')} /> : null}
      {screen === 'publish' ? <PublishView state={authorState} controller={author} /> : null}
      {screen === 'settings' ? <>
        <SettingsView machine={state} state={accountState} controller={account} machineController={machine} onFollowProfile={followFromSettings(setupSync, setScreen)} />
        <ConnectionsView state={connectionsState} controller={connections} />
        <UpdateView state={updateState} controller={updates} />
      </> : null}
    </ShellView>}
  </StartupBoundary>;
}

createRoot(document.getElementById('root')!).render(<App />);
