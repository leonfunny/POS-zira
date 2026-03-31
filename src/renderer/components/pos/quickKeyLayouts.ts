export type PosMode = 'retail' | 'salon' | 'b2b' | 'restaurant';

export type QuickKeyActionId =
  | 'discount:5'
  | 'discount:10'
  | 'discount:20'
  | 'tip:5'
  | 'tip:10'
  | 'tip:15'
  | 'clear'
  | 'open_drawer'
  | 'hold'
  | 'resume'
  | 'note'
  | 'sync_products'
  | 'sync_orders'
  | 'toggle_ads'
  | 'invoice'
  | 'split_even'
  | 'order:dine_in'
  | 'order:takeout'
  | 'order:delivery'
  | 'course:1'
  | 'course:2'
  | 'course:3'
  | 'course:4';

export interface QuickKeyTile {
  id: string;
  action: QuickKeyActionId;
  label?: string;
  variant?: 'primary' | 'neutral' | 'danger';
}

export function getDefaultTiles(mode: PosMode, t: (key: string) => string): QuickKeyTile[] {
  if (mode === 'retail') {
    return [
      { id: 'd5', action: 'discount:5', label: `${t('pos.quickDiscount')} 5%`, variant: 'primary' },
      { id: 'd10', action: 'discount:10', label: `${t('pos.quickDiscount')} 10%`, variant: 'primary' },
      { id: 'd20', action: 'discount:20', label: `${t('pos.quickDiscount')} 20%`, variant: 'primary' },
      { id: 'clear', action: 'clear', label: t('pos.cart.clear'), variant: 'danger' },
      { id: 'drawer', action: 'open_drawer', label: t('pos.openDrawer') },
      { id: 'hold', action: 'hold', label: t('pos.hold') },
      { id: 'resume', action: 'resume', label: t('pos.resume'), variant: 'primary' },
      { id: 'note', action: 'note', label: t('pos.notes') },
      { id: 'syncp', action: 'sync_products', label: t('pos.syncProducts') },
      { id: 'synco', action: 'sync_orders', label: t('pos.syncOrders') },
      { id: 'ads', action: 'toggle_ads', label: t('pos.startAds') },
    ];
  }

  if (mode === 'salon') {
    return [
      { id: 't5', action: 'tip:5', label: `${t('pos.salon.tip')} 5%`, variant: 'primary' },
      { id: 't10', action: 'tip:10', label: `${t('pos.salon.tip')} 10%`, variant: 'primary' },
      { id: 't15', action: 'tip:15', label: `${t('pos.salon.tip')} 15%`, variant: 'primary' },
      { id: 'clear', action: 'clear', label: t('pos.cart.clear'), variant: 'danger' },
      { id: 'drawer', action: 'open_drawer', label: t('pos.openDrawer') },
      { id: 'hold', action: 'hold', label: t('pos.hold') },
      { id: 'resume', action: 'resume', label: t('pos.resume'), variant: 'primary' },
      { id: 'note', action: 'note', label: t('pos.notes') },
      { id: 'syncp', action: 'sync_products', label: t('pos.syncProducts') },
      { id: 'synco', action: 'sync_orders', label: t('pos.syncOrders') },
    ];
  }

  if (mode === 'b2b') {
    return [
      { id: 'd5', action: 'discount:5', label: `${t('pos.quickDiscount')} 5%`, variant: 'primary' },
      { id: 'd10', action: 'discount:10', label: `${t('pos.quickDiscount')} 10%`, variant: 'primary' },
      { id: 'clear', action: 'clear', label: t('pos.cart.clear'), variant: 'danger' },
      { id: 'drawer', action: 'open_drawer', label: t('pos.openDrawer') },
      { id: 'hold', action: 'hold', label: t('pos.hold') },
      { id: 'resume', action: 'resume', label: t('pos.resume'), variant: 'primary' },
      { id: 'invoice', action: 'invoice', label: t('pos.payment.invoice'), variant: 'primary' },
      { id: 'note', action: 'note', label: t('pos.notes') },
      { id: 'syncp', action: 'sync_products', label: t('pos.syncProducts') },
      { id: 'synco', action: 'sync_orders', label: t('pos.syncOrders') },
    ];
  }

  return [
    { id: 'c1', action: 'course:1', label: `C1 ${t('pos.restaurant.starter')}`, variant: 'primary' },
    { id: 'c2', action: 'course:2', label: `C2 ${t('pos.restaurant.main')}` },
    { id: 'c3', action: 'course:3', label: `C3 ${t('pos.restaurant.dessert')}` },
    { id: 'c4', action: 'course:4', label: `C4 ${t('pos.restaurant.drinks')}` },
    { id: 'dine', action: 'order:dine_in', label: t('pos.restaurant.dineIn'), variant: 'primary' },
    { id: 'take', action: 'order:takeout', label: t('pos.restaurant.takeout') },
    { id: 'del', action: 'order:delivery', label: t('pos.restaurant.delivery') },
    { id: 'split', action: 'split_even', label: t('pos.splitEven'), variant: 'danger' },
    { id: 'resume', action: 'resume', label: t('pos.resume'), variant: 'primary' },
    { id: 'note', action: 'note', label: t('pos.notes') },
    { id: 'drawer', action: 'open_drawer', label: t('pos.openDrawer') },
  ];
}

export function getActionOptions(mode: PosMode, t: (key: string) => string): Array<{ value: QuickKeyActionId; label: string }> {
  const base = [
    { value: 'clear', label: t('pos.cart.clear') },
    { value: 'open_drawer', label: t('pos.openDrawer') },
    { value: 'hold', label: t('pos.hold') },
    { value: 'resume', label: t('pos.resume') },
    { value: 'note', label: t('pos.notes') },
    { value: 'sync_products', label: t('pos.syncProducts') },
    { value: 'sync_orders', label: t('pos.syncOrders') },
  ] as Array<{ value: QuickKeyActionId; label: string }>;

  if (mode === 'retail') {
    return [
      { value: 'discount:5', label: `${t('pos.quickDiscount')} 5%` },
      { value: 'discount:10', label: `${t('pos.quickDiscount')} 10%` },
      { value: 'discount:20', label: `${t('pos.quickDiscount')} 20%` },
      { value: 'toggle_ads', label: t('pos.startAds') },
      ...base,
    ];
  }

  if (mode === 'salon') {
    return [
      { value: 'tip:5', label: `${t('pos.salon.tip')} 5%` },
      { value: 'tip:10', label: `${t('pos.salon.tip')} 10%` },
      { value: 'tip:15', label: `${t('pos.salon.tip')} 15%` },
      ...base,
    ];
  }

  if (mode === 'b2b') {
    return [
      { value: 'discount:5', label: `${t('pos.quickDiscount')} 5%` },
      { value: 'discount:10', label: `${t('pos.quickDiscount')} 10%` },
      { value: 'invoice', label: t('pos.payment.invoice') },
      ...base,
    ];
  }

  return [
    { value: 'course:1', label: `C1 ${t('pos.restaurant.starter')}` },
    { value: 'course:2', label: `C2 ${t('pos.restaurant.main')}` },
    { value: 'course:3', label: `C3 ${t('pos.restaurant.dessert')}` },
    { value: 'course:4', label: `C4 ${t('pos.restaurant.drinks')}` },
    { value: 'order:dine_in', label: t('pos.restaurant.dineIn') },
    { value: 'order:takeout', label: t('pos.restaurant.takeout') },
    { value: 'order:delivery', label: t('pos.restaurant.delivery') },
    { value: 'split_even', label: t('pos.splitEven') },
    ...base,
  ];
}
