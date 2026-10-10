import { ArrowUpRight, CalendarDays, Package, ShoppingCart } from 'lucide-react';

export type DashboardDestination = 'today' | 'inventory' | 'orders';

export function MobileDashboard({ attentionCount, partCount, purchaseCount, onOpen }: {
  attentionCount: number;
  partCount: number;
  purchaseCount: number;
  onOpen: (view: DashboardDestination) => void;
}) {
  const destinations = [
    { id: 'today', label: 'Today', detail: attentionCount ? `${attentionCount} ${attentionCount === 1 ? 'part needs' : 'parts need'} attention` : 'All caught up', Icon: CalendarDays },
    { id: 'inventory', label: 'Inventory', detail: `${partCount} ${partCount === 1 ? 'part' : 'parts'} in the cabinet`, Icon: Package },
    { id: 'orders', label: 'Orders', detail: purchaseCount ? `${purchaseCount} ${purchaseCount === 1 ? 'part' : 'parts'} to buy` : 'Purchases & refills', Icon: ShoppingCart },
  ] as const;

  return <section className="mobile-dashboard" aria-label="Workshop dashboard">
    <div className="dashboard-heading"><span className="eyebrow">WORKSHOP</span><h1>Dashboard</h1></div>
    <div className="dashboard-destinations">
      {destinations.map(({ id, label, detail, Icon }, index) => <button className={`dashboard-destination dashboard-${id}`} key={id} aria-label={`Open ${label}`} onClick={() => onOpen(id)}>
        <span className="dashboard-destination-icon"><Icon size={25} aria-hidden="true" /></span>
        <span className="dashboard-destination-copy"><strong>{label}</strong><span>{detail}</span></span>
        <span className="dashboard-destination-end"><span aria-hidden="true">0{index + 1}</span><ArrowUpRight size={21} aria-hidden="true" /></span>
      </button>)}
    </div>
  </section>;
}
