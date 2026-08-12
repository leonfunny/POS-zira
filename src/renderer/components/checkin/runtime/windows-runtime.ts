import type { CheckinQueueItem, CheckinRuntime } from './types';
import type { BooksyBookingSummary } from '../../../../shared/types';

function getElectronApi(): Window['electronAPI'] {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('Windows check-in runtime requires window.electronAPI');
  }
  return api;
}

export const windowsCheckinRuntime: CheckinRuntime = {
  // Preserve the historical cross-remount snapshot on Windows. No idle reset
  // is enabled unless a host explicitly supplies inactivityResetMs.
  session: { scopeKey: 'windows-default' },
  presentation: {
    audience: 'staff',
    showQueue: true,
    showStats: true,
    allowStatusMutations: true,
    allowBookingStaffOverride: true,
    requireCustomerPhone: false,
  },
  checkins: {
    getToday: async () => getElectronApi().checkin.getToday() as unknown as CheckinQueueItem[],
    getStats: async () => getElectronApi().checkin.getStats(),
    createWithCustomer: async (input) => getElectronApi().checkin.createWithCustomer(input),
    printConfirmation: async (input) => getElectronApi().checkin.printConfirmation(input),
    startService: async (id) => getElectronApi().checkin.startService(id),
    complete: async (id) => getElectronApi().checkin.complete(id),
    markNoShow: async (id) => getElectronApi().checkin.markNoShow(id),
  },
  bookings: {
    getToday: async () => (await getElectronApi().booksy.getBookings()).map((booking: BooksyBookingSummary) => ({
      ...booking,
      source: 'booksy' as const,
    })),
  },
  catalog: {
    getServices: async () => {
      const products = await getElectronApi().pos.products.getAll();
      return products.map((product: any) => ({
        id: product.id,
        name: product.name,
        retail_price: product.retail_price,
        category_id: product.category_id,
      }));
    },
    getCategories: async () => {
      const categories = await getElectronApi().pos.categories.getAll();
      return categories.map((category: any) => ({ id: category.id, name: category.name }));
    },
    getStaff: async () => {
      const staff = await getElectronApi().pos.staff.getAll();
      return staff.map((person: any) => ({ id: person.id, name: person.name }));
    },
  },
  customers: {
    getByPhone: async (phone) => getElectronApi().salonCustomer.getByPhone(phone),
    create: async (input) => getElectronApi().salonCustomer.create(input),
    getRecommendations: async (customerId) => getElectronApi().salonCustomer.getRecommendations(customerId),
  },
  servicePopularity: {
    get: async () => getElectronApi().servicePopularity.get(),
  },
};
