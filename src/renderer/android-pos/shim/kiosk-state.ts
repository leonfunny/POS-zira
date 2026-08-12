let customerCheckinKioskActive = false;

/**
 * The native back guard mounts before React, so the Android shell publishes its
 * customer-kiosk ownership through this tiny process-local signal. It carries
 * no customer data and is reset when the shell unmounts.
 */
export function setCustomerCheckinKioskActive(active: boolean): void {
  customerCheckinKioskActive = active;
}

export function isCustomerCheckinKioskActive(): boolean {
  return customerCheckinKioskActive;
}
