import { useMemo, useState } from 'react';
import {
  IconActivityHeartbeat,
  IconAdjustments,
  IconBell,
  IconBroadcast,
  IconCheck,
  IconClock,
  IconInbox,
  IconLanguage,
  IconListDetails,
  IconLock,
} from '@tabler/icons-react';

const NAVIGATION = Object.freeze([
  { id: 'monitor', icon: IconActivityHeartbeat },
  { id: 'channels', icon: IconBroadcast },
  { id: 'inbox', icon: IconInbox },
  { id: 'activity', icon: IconListDetails },
  { id: 'settings', icon: IconAdjustments },
]);

const TEXT = Object.freeze({
  en: {
    language: '中文',
    preview: 'Fictional interface preview',
    localOnly: 'Presentation data only',
    title: 'Reminder console',
    nav: { monitor: 'Monitor', channels: 'Channels', inbox: 'Inbox', activity: 'Activity', settings: 'Settings' },
    monitorTitle: 'Monitoring overview',
    monitorIntro: 'A neutral preview of the status, event, and delivery evidence surfaces.',
    sources: 'Sources monitored',
    liveNow: 'Live now',
    unresolved: 'Needs attention',
    boundaryTitle: 'Evidence boundary',
    boundaryText: 'Accepted means the configured delivery adapter accepted a request. Handset display remains unverified.',
    channelsTitle: 'Channels',
    channelsIntro: 'Fictional identifiers demonstrate independent monitoring state.',
    status: 'Status',
    states: { live: 'Live', offline: 'Offline', unknown: 'Unknown' },
    eligible: 'Currently eligible',
    subscriptions: 'Active subscriptions',
    inboxTitle: 'Local inbox',
    inboxIntro: 'The local adapter is an in-memory development surface and cannot notify a real device.',
    accepted: 'Adapter accepted',
    unverified: 'Handset unverified',
    activityTitle: 'Recent activity',
    activityIntro: 'Events retain their frozen denominator and reconciliation state.',
    liveEvent: 'Live event created',
    unknownEvent: 'Unknown observation recorded',
    denominatorText: 'denominator',
    noEventCreated: 'no event created',
    settingsTitle: 'Settings',
    settingsIntro: 'Runtime secrets and private endpoints stay on the server and are never shown here.',
    authentication: 'Administrator authentication',
    authenticationDetail: 'Required for the operational dashboard.',
    deliveryMode: 'Delivery mode',
    deliveryDetail: 'Configured by the self-hosting operator.',
    demoNotice: 'This preview has no account, recipient, status endpoint, or delivery connection.',
  },
  zh: {
    language: 'EN',
    preview: '虚构界面预览',
    localOnly: '仅为展示数据',
    title: '提醒控制台',
    nav: { monitor: '监控', channels: '频道', inbox: '收件箱', activity: '活动', settings: '设置' },
    monitorTitle: '监控概览',
    monitorIntro: '中立展示状态、事件与发送证据界面。',
    sources: '监控来源',
    liveNow: '正在直播',
    unresolved: '需要处理',
    boundaryTitle: '证据边界',
    boundaryText: '“已接受”仅表示发送适配器接受了请求，手机是否展示仍未验证。',
    channelsTitle: '频道',
    channelsIntro: '虚构标识用于展示各频道独立的监控状态。',
    status: '状态',
    states: { live: '直播中', offline: '未开播', unknown: '未知' },
    eligible: '当前有效接收者',
    subscriptions: '有效订阅',
    inboxTitle: '本地收件箱',
    inboxIntro: '本地适配器只是内存中的开发工具，不能通知真实设备。',
    accepted: '适配器已接受',
    unverified: '手机未验证',
    activityTitle: '近期活动',
    activityIntro: '每个事件保留其冻结分母与对账状态。',
    liveEvent: '已创建开播事件',
    unknownEvent: '已记录未知观察',
    denominatorText: '分母',
    noEventCreated: '未创建事件',
    settingsTitle: '设置',
    settingsIntro: '运行密钥和私有接口仅保存在服务器，绝不会在此显示。',
    authentication: '管理员认证',
    authenticationDetail: '进入运营后台前必须完成认证。',
    deliveryMode: '发送方式',
    deliveryDetail: '由自托管部署者配置。',
    demoNotice: '此预览不包含账号、接收者、状态接口或发送连接。',
  },
});

const FICTIONAL_CHANNELS = Object.freeze([
  { id: 'demo-channel-a', state: 'live', subscriptions: 12, eligible: 12 },
  { id: 'demo-channel-b', state: 'offline', subscriptions: 7, eligible: 6 },
  { id: 'demo-channel-c', state: 'unknown', subscriptions: 2, eligible: 1 },
]);

function StateDot({ state }) {
  return <span className={`state-dot state-dot--${state}`} aria-hidden="true" />;
}

function MonitorPage({ copy }) {
  return (
    <Page title={copy.monitorTitle} intro={copy.monitorIntro}>
      <div className="metric-grid" aria-label={copy.monitorTitle}>
        <Metric icon={IconBroadcast} label={copy.sources} value="3" />
        <Metric icon={IconActivityHeartbeat} label={copy.liveNow} value="1" tone="positive" />
        <Metric icon={IconClock} label={copy.unresolved} value="2" tone="attention" />
      </div>
      <section className="surface evidence-card">
        <span className="icon-well"><IconLock size={20} stroke={1.8} /></span>
        <div>
          <h3>{copy.boundaryTitle}</h3>
          <p>{copy.boundaryText}</p>
        </div>
      </section>
    </Page>
  );
}

function ChannelsPage({ copy }) {
  return (
    <Page title={copy.channelsTitle} intro={copy.channelsIntro}>
      <div className="surface divided-list">
        {FICTIONAL_CHANNELS.map((channel) => (
          <article className="channel-row" key={channel.id}>
            <span className="channel-glyph"><IconBroadcast size={20} stroke={1.7} /></span>
            <div className="row-primary">
              <h3>{channel.id}</h3>
              <p><StateDot state={channel.state} /> {copy.status}: {copy.states[channel.state]}</p>
            </div>
            <dl className="compact-pairs">
              <div><dt>{copy.subscriptions}</dt><dd>{channel.subscriptions}</dd></div>
              <div><dt>{copy.eligible}</dt><dd>{channel.eligible}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </Page>
  );
}

function InboxPage({ copy }) {
  return (
    <Page title={copy.inboxTitle} intro={copy.inboxIntro}>
      <div className="surface divided-list">
        {['demo-event-a / receipt-01', 'demo-event-a / receipt-02'].map((label) => (
          <article className="message-row" key={label}>
            <span className="icon-well icon-well--positive"><IconCheck size={19} stroke={2} /></span>
            <div className="row-primary"><h3>{label}</h3><p>{copy.accepted}</p></div>
            <span className="quiet-pill">{copy.unverified}</span>
          </article>
        ))}
      </div>
    </Page>
  );
}

function ActivityPage({ copy }) {
  return (
    <Page title={copy.activityTitle} intro={copy.activityIntro}>
      <ol className="surface timeline">
        <li><span className="timeline-mark timeline-mark--live" /><div><h3>{copy.liveEvent}</h3><p>demo-channel-a · {copy.denominatorText} 12</p></div><time>08:12</time></li>
        <li><span className="timeline-mark" /><div><h3>{copy.unknownEvent}</h3><p>demo-channel-c · {copy.noEventCreated}</p></div><time>08:10</time></li>
      </ol>
    </Page>
  );
}

function SettingsPage({ copy }) {
  return (
    <Page title={copy.settingsTitle} intro={copy.settingsIntro}>
      <div className="surface divided-list">
        <Setting icon={IconLock} title={copy.authentication} detail={copy.authenticationDetail} />
        <Setting icon={IconBell} title={copy.deliveryMode} detail={copy.deliveryDetail} />
      </div>
      <p className="demo-notice">{copy.demoNotice}</p>
    </Page>
  );
}

function Page({ title, intro, children }) {
  return <section className="page-panel"><header className="page-heading"><h2>{title}</h2><p>{intro}</p></header>{children}</section>;
}

function Metric({ icon: Icon, label, value, tone = 'neutral' }) {
  return <article className={`surface metric metric--${tone}`}><Icon size={22} stroke={1.7} /><span>{label}</span><strong>{value}</strong></article>;
}

function Setting({ icon: Icon, title, detail }) {
  return <article className="setting-row"><span className="icon-well"><Icon size={20} stroke={1.8} /></span><div><h3>{title}</h3><p>{detail}</p></div></article>;
}

export default function App() {
  const [language, setLanguage] = useState('en');
  const [activePage, setActivePage] = useState('monitor');
  const copy = TEXT[language];
  const page = useMemo(() => {
    if (activePage === 'channels') return <ChannelsPage copy={copy} />;
    if (activePage === 'inbox') return <InboxPage copy={copy} />;
    if (activePage === 'activity') return <ActivityPage copy={copy} />;
    if (activePage === 'settings') return <SettingsPage copy={copy} />;
    return <MonitorPage copy={copy} />;
  }, [activePage, copy]);

  return (
    <div className="preview-shell">
      <header className="preview-header">
        <div>
          <span className="eyebrow">{copy.preview}</span>
          <h1>{copy.title}</h1>
        </div>
        <button className="language-button" type="button" onClick={() => setLanguage(language === 'en' ? 'zh' : 'en')}>
          <IconLanguage size={17} stroke={1.8} aria-hidden="true" />
          {copy.language}
        </button>
      </header>
      <div className="preview-badge"><span className="state-dot state-dot--unknown" />{copy.localOnly}</div>
      <main>{page}</main>
      <nav className="tab-bar" aria-label="Primary" role="tablist">
        {NAVIGATION.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activePage === id}
            className={activePage === id ? 'tab-button tab-button--active' : 'tab-button'}
            onClick={() => setActivePage(id)}
          >
            <Icon size={21} stroke={1.7} aria-hidden="true" />
            <span>{copy.nav[id]}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
