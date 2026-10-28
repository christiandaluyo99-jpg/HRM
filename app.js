const THEME_STORAGE_KEY = 'the-aster-theme-v1';
const ADMIN_LOCK_KEY = 'the-aster-administrator-lock-v1';
const ADMIN_LOCK_IDLE_MS = 15 * 60 * 1000;
const RESERVATIONS_PER_PAGE = 20;
const ADMIN_ACTIVITY_LIMIT = 500;
const DEFAULT_ADMIN_PROFILE = { name: 'Alex Morgan', position: 'Front desk administrator' };
const defaultRoomTypes = [
  { name: 'Garden Twin', rooms: ['101', '102', '103'], rate: 225, capacity: 3 },
  { name: 'Deluxe Queen', rooms: ['201', '202', '203', '204'], rate: 185, capacity: 2 },
  { name: 'King Suite', rooms: ['301', '302', '303'], rate: 285, capacity: 2 },
  { name: 'The Aster Penthouse', rooms: ['401', '402'], rate: 460, capacity: 4 }
];

let adminProfile = { ...DEFAULT_ADMIN_PROFILE };
let adminAccounts = [];
let adminActivity = [];
let activeAdminEmail = '';
let roomTypes = defaultRoomTypes.map((type) => ({ ...type, rooms: [...type.rooms] }));
let allRooms = roomTypes.flatMap((type) => type.rooms.map((number) => ({ ...type, number })));
let reservations = [];
let dataRevision = 0;
let saveQueue = Promise.resolve();

function rebuildRoomInventory() {
  allRooms = roomTypes.flatMap((type) => type.rooms.map((number) => ({ ...type, number })));
}

function saveRoomTypes() {
  persistChanges('/api/rooms', () => ({ roomTypes }));
}

const elements = {
  login: document.querySelector('#admin-login'),
  loginForm: document.querySelector('#admin-login-form'),
  loginEmail: document.querySelector('#admin-email'),
  loginPassword: document.querySelector('#admin-password'),
  loginError: document.querySelector('#login-error'),
  appShell: document.querySelector('#app-shell'),
  roomsDialog: document.querySelector('#rooms-dialog'),
  roomManagerList: document.querySelector('#managed-room-list'),
  roomsManagerSummary: document.querySelector('#rooms-manager-summary'),
  roomEditDialog: document.querySelector('#room-edit-dialog'),
  roomForm: document.querySelector('#room-form'),
  roomNumber: document.querySelector('#room-number-input'),
  originalRoomNumber: document.querySelector('#room-original-number'),
  managedRoomType: document.querySelector('#managed-room-type-input'),
  roomFormError: document.querySelector('#room-form-error'),
  roomEditTitle: document.querySelector('#room-edit-title'),
  saveRoomLabel: document.querySelector('#save-room-label'),
  guestSearch: document.querySelector('#guest-search'),
  guestRows: document.querySelector('#guest-rows'),
  guestEmpty: document.querySelector('#guest-empty'),
  adminProfileName: document.querySelector('#admin-profile-name'),
  adminProfilePosition: document.querySelector('#admin-profile-position'),
  adminProfileEmail: document.querySelector('#admin-profile-email'),
  adminProfileStatus: document.querySelector('#admin-profile-status'),
  adminAccountForm: document.querySelector('#admin-account-form'),
  adminAccountStatus: document.querySelector('#admin-account-status'),
  adminAccountList: document.querySelector('#admin-account-list'),
  adminActivityRows: document.querySelector('#admin-activity-rows'),
  adminActivityEmpty: document.querySelector('#admin-activity-empty'),
  adminCheckedInRows: document.querySelector('#admin-checked-in-rows'),
  adminCheckedInEmpty: document.querySelector('#admin-checked-in-empty'),
  adminGuestDialog: document.querySelector('#admin-guest-dialog'),
  adminGuestForm: document.querySelector('#admin-guest-form'),
  adminGuestId: document.querySelector('#admin-guest-reservation-id'),
  adminGuestFields: document.querySelector('#admin-guest-fields'),
  adminGuestName: document.querySelector('#admin-guest-name'),
  adminGuestEmail: document.querySelector('#admin-guest-email'),
  adminGuestPhone: document.querySelector('#admin-guest-phone'),
  adminGuestCheckout: document.querySelector('#admin-guest-checkout'),
  adminGuestCheckoutLabel: document.querySelector('#admin-guest-checkout-label'),
  adminGuestRoomNote: document.querySelector('#admin-guest-room-note'),
  adminGuestError: document.querySelector('#admin-guest-error'),
  adminGuestDialogTitle: document.querySelector('#admin-guest-dialog-title'),
  adminGuestSaveLabel: document.querySelector('#admin-guest-save-label'),
  rows: document.querySelector('#booking-rows'),
  empty: document.querySelector('#empty-state'),
  search: document.querySelector('#booking-search'),
  filter: document.querySelector('#status-filter'),
  pagination: document.querySelector('#reservation-pagination'),
  pageLabel: document.querySelector('#reservation-page-label'),
  dialog: document.querySelector('#booking-dialog'),
  form: document.querySelector('#booking-form'),
  checkIn: document.querySelector('#checkin-input'),
  checkOut: document.querySelector('#checkout-input'),
  roomType: document.querySelector('#room-type-input'),
  guests: document.querySelector('#guests-input'),
  phone: document.querySelector('#phone-input'),
  availability: document.querySelector('#availability-message'),
  submit: document.querySelector('#submit-booking'),
  toast: document.querySelector('#toast')
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const result = await response.json();
      if (typeof result.error === 'string') message = result.error;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function applyServerState(state) {
  reservations = state.reservations;
  roomTypes = state.roomTypes;
  adminProfile = state.administrator;
  adminAccounts = state.adminAccounts;
  adminActivity = state.activityHistory;
  dataRevision = state.revision;
  rebuildRoomInventory();
  elements.adminProfileName.value = adminProfile.name;
  elements.adminProfilePosition.value = adminProfile.position;
  renderAdminIdentity();
  render();
}

async function loadServerState() {
  applyServerState(await apiRequest('/api/state'));
}

function persistChanges(path, getBody) {
  const operation = saveQueue.then(async () => {
    try {
      const result = await apiRequest(path, {
        method: 'PUT',
        body: JSON.stringify({ ...getBody(), revision: dataRevision })
      });
      dataRevision = result.revision;
    } catch (error) {
      console.error('Changes could not be saved to MySQL.', error);
      showToast(`${error.message} Refreshing records from the server.`, true);
      await loadServerState();
    }
  });
  saveQueue = operation.catch((error) => {
    console.error('Server records could not be refreshed.', error);
    showToast(`Could not refresh records from MySQL: ${error.message}`, true);
  });
  return saveQueue;
}

function localDate(offset = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromKey(value) {
  return new Date(`${value}T12:00:00`);
}

function shortDate(value) {
  return dateFromKey(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fullDate(value) {
  return dateFromKey(value).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function nightsBetween(checkIn, checkOut) {
  return Math.round((dateFromKey(checkOut) - dateFromKey(checkIn)) / 86400000);
}

function formatPhilippinePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (!/^09\d{9}$/.test(digits)) return '';
  const localNumber = digits.slice(1);
  const groups = [localNumber.slice(0, 3), localNumber.slice(3, 6), localNumber.slice(6, 10)];
  return `+63 ${groups.join(' ')}`;
}

function sanitizePhilippinePhoneInput(input) {
  input.value = input.value.replace(/\D/g, '');
  input.setCustomValidity(input.value && !/^09\d{9}$/.test(input.value) ? 'Enter exactly 11 digits, starting with 09.' : '');
}

let reservationPage = 1;
let toastTimer;

function saveReservations(bookings = reservations) {
  persistChanges('/api/reservations', () => ({ reservations: bookings }));
}

function reservationOverlaps(reservation, checkIn, checkOut, ignoreId = null) {
  return reservation.id !== ignoreId && reservation.status !== 'Cancelled' && reservation.checkIn < checkOut && reservation.checkOut > checkIn;
}

function isRoomFree(room, checkIn, checkOut, ignoreId = null) {
  return !reservations.some((reservation) => reservation.room === room && reservationOverlaps(reservation, checkIn, checkOut, ignoreId));
}

function freeRooms(type, checkIn, checkOut) {
  return allRooms.filter((room) => room.name === type && isRoomFree(room.number, checkIn, checkOut));
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function avatarClass(name) {
  const palette = ['avatar-green', 'avatar-peach', 'avatar-blue', ''];
  const score = Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return palette[score % palette.length];
}

function statusClass(status) {
  return `status-${status.toLowerCase().replaceAll(' ', '-')}`;
}

function rowActions(reservation) {
  if (reservation.status === 'Reserved') {
    return `<button class="row-action" type="button" data-action="check-in" data-id="${reservation.id}">Check in</button><button class="row-action cancel-action" type="button" data-action="cancel" data-id="${reservation.id}" aria-label="Cancel ${escapeHtml(reservation.guest)}'s reservation" title="Cancel reservation"><i data-lucide="x"></i></button>`;
  }
  if (reservation.status === 'Checked in') {
    return `<button class="row-action" type="button" data-action="check-out" data-id="${reservation.id}">Check out</button>`;
  }
  if (reservation.status === 'Cancelled') {
    return `<button class="row-action cancel-action" type="button" data-action="delete" data-id="${reservation.id}" aria-label="Remove ${escapeHtml(reservation.guest)}'s cancelled reservation" title="Remove reservation"><i data-lucide="trash-2"></i></button>`;
  }
  return '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderReservations() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const status = elements.filter.value;
  const filtered = [...reservations]
    .filter((reservation) => status === 'all' || reservation.status === status)
    .filter((reservation) => !query || `${reservation.guest} ${reservation.email} ${reservation.room} ${reservation.roomType}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.checkIn.localeCompare(right.checkIn));
  const pageCount = Math.ceil(filtered.length / RESERVATIONS_PER_PAGE);
  reservationPage = Math.min(reservationPage, Math.max(pageCount, 1));
  const startIndex = (reservationPage - 1) * RESERVATIONS_PER_PAGE;
  const pageReservations = filtered.slice(startIndex, startIndex + RESERVATIONS_PER_PAGE);

  elements.rows.innerHTML = pageReservations.map((reservation) => {
    const nights = nightsBetween(reservation.checkIn, reservation.checkOut);
    const dateRange = `${shortDate(reservation.checkIn)} – ${shortDate(reservation.checkOut)}`;
    return `<tr>
      <td><div class="guest-cell"><span class="guest-avatar ${avatarClass(reservation.guest)}">${escapeHtml(initials(reservation.guest))}</span><span class="guest-name"><strong>${escapeHtml(reservation.guest)}</strong><span>${escapeHtml(reservation.email)}</span></span></div></td>
      <td><span class="stay-cell"><strong>${dateRange}</strong><span>${nights} ${nights === 1 ? 'night' : 'nights'} · ${reservation.guests} ${reservation.guests === 1 ? 'guest' : 'guests'}</span></span></td>
      <td><span class="room-cell"><strong>${escapeHtml(reservation.roomType)}</strong><span>Room ${escapeHtml(reservation.room)}</span></span></td>
      <td><span class="status-pill ${statusClass(reservation.status)}">${reservation.status}</span></td>
      <td><div class="row-actions">${rowActions(reservation)}</div></td>
    </tr>`;
  }).join('');

  elements.empty.hidden = filtered.length > 0;
  document.querySelector('.table-scroll table').hidden = filtered.length === 0;
  document.querySelector('#booking-count').textContent = reservations.length;
  document.querySelector('#nav-reservation-count').textContent = reservations.filter((reservation) => reservation.status !== 'Cancelled').length;
  const firstVisible = filtered.length ? startIndex + 1 : 0;
  const lastVisible = Math.min(startIndex + RESERVATIONS_PER_PAGE, filtered.length);
  document.querySelector('#table-summary').textContent = filtered.length
    ? `Showing ${firstVisible}–${lastVisible} of ${filtered.length} reservations`
    : 'Showing 0 reservations';
  elements.pagination.hidden = pageCount <= 1;
  elements.pagination.querySelector('[data-page-action="previous"]').disabled = reservationPage <= 1;
  elements.pagination.querySelector('[data-page-action="next"]').disabled = reservationPage >= pageCount;
  elements.pageLabel.textContent = `Page ${reservationPage} of ${pageCount}`;
  if (window.lucide) window.lucide.createIcons();
}

function handleReservationPagination(event) {
  const button = event.target.closest('[data-page-action]');
  if (!button || button.disabled) return;
  reservationPage += button.dataset.pageAction === 'next' ? 1 : -1;
  renderReservations();
}

function renderGuests() {
  const query = elements.guestSearch.value.trim().toLocaleLowerCase();
  const guestRecords = new Map();
  reservations.forEach((reservation) => {
    const key = reservation.email.trim().toLocaleLowerCase() || reservation.guest.trim().toLocaleLowerCase();
    const record = guestRecords.get(key) || { guest: reservation.guest, email: reservation.email, phone: reservation.phone, stays: 0, latest: reservation };
    record.stays += 1;
    if (reservation.checkIn >= record.latest.checkIn) record.latest = reservation;
    if (!record.phone && reservation.phone) record.phone = reservation.phone;
    guestRecords.set(key, record);
  });

  const guests = [...guestRecords.values()]
    .filter((guest) => !query || `${guest.guest} ${guest.email} ${guest.phone}`.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.guest.localeCompare(right.guest));

  elements.guestRows.innerHTML = guests.map((guest) => {
    const latestStay = `${shortDate(guest.latest.checkIn)} – ${shortDate(guest.latest.checkOut)}`;
    return `<tr>
      <td><div class="guest-cell"><span class="guest-avatar ${avatarClass(guest.guest)}">${escapeHtml(initials(guest.guest))}</span><span class="guest-name"><strong>${escapeHtml(guest.guest)}</strong><span>${guest.stays} ${guest.stays === 1 ? 'stay' : 'stays'}</span></span></div></td>
      <td>${escapeHtml(guest.email || '—')}</td>
      <td>${escapeHtml(guest.phone || '—')}</td>
      <td><span class="guest-stay-count">${guest.stays}</span></td>
      <td><span class="stay-cell"><strong>${latestStay}</strong><span>${escapeHtml(guest.latest.roomType)} · Room ${escapeHtml(guest.latest.room)}</span></span></td>
      <td><span class="status-pill ${statusClass(guest.latest.status)}">${escapeHtml(guest.latest.status)}</span></td>
    </tr>`;
  }).join('');

  elements.guestEmpty.hidden = guests.length > 0;
  document.querySelector('.guest-table').hidden = guests.length === 0;
  document.querySelector('#guest-count').textContent = guestRecords.size;
  document.querySelector('#guest-summary').textContent = `Showing ${guests.length} of ${guestRecords.size} guests`;
}

function renderAdminIdentity() {
  const adminInitials = initials(adminProfile.name) || 'AM';
  document.querySelector('#welcome-title').textContent = adminProfile.name;
  document.querySelector('#welcome-role').textContent = adminProfile.position;
  document.querySelector('#administrator-title').textContent = `${adminProfile.name}'s administrator panel`;
  document.querySelector('#sidebar-admin-name').textContent = adminProfile.name;
  document.querySelector('#sidebar-admin-position').textContent = `${adminProfile.position} · Sign out`;
  document.querySelector('#sidebar-admin-avatar').textContent = adminInitials;
  document.querySelector('#logout-button').setAttribute('aria-label', `Sign out ${adminProfile.name}`);
  elements.adminProfileEmail.value = activeAdminEmail;
}

function renderAdminPanel() {
  const uniqueGuests = new Set(reservations.map((reservation) => reservation.email.trim().toLocaleLowerCase() || reservation.guest.trim().toLocaleLowerCase()));
  const checkedIn = reservations.filter((reservation) => reservation.status === 'Checked in');
  document.querySelector('#admin-room-count').textContent = `${allRooms.length} ${allRooms.length === 1 ? 'room' : 'rooms'}`;
  document.querySelector('#admin-booking-count').textContent = `${reservations.length} ${reservations.length === 1 ? 'reservation' : 'reservations'}`;
  document.querySelector('#admin-guest-count').textContent = `${uniqueGuests.size} ${uniqueGuests.size === 1 ? 'guest' : 'guests'}`;
  document.querySelector('#admin-checked-in-count').textContent = checkedIn.length;
  elements.adminAccountList.innerHTML = adminAccounts.map((account) => `
    <li class="admin-account-row">
      <span class="guest-avatar ${avatarClass(account.name)}">${escapeHtml(initials(account.name))}</span>
      <span class="admin-account-copy"><strong>${escapeHtml(account.name)}</strong><span>${escapeHtml(account.position)} · ${escapeHtml(account.email)}</span></span>
    </li>`).join('');
  elements.adminCheckedInRows.innerHTML = checkedIn.map((reservation) => `
    <tr>
      <td><div class="guest-cell"><span class="guest-avatar ${avatarClass(reservation.guest)}">${escapeHtml(initials(reservation.guest))}</span><span class="guest-name"><strong>${escapeHtml(reservation.guest)}</strong><span>${escapeHtml(reservation.email)}</span></span></div></td>
      <td><span class="room-cell"><strong>Room ${escapeHtml(reservation.room)}</strong><span>${escapeHtml(reservation.roomType)}</span></span></td>
      <td><span class="stay-cell"><strong>${shortDate(reservation.checkOut)}</strong><span>Check-out</span></span></td>
      <td><div class="admin-guest-actions"><button class="secondary-button" type="button" data-admin-guest-action="edit" data-id="${reservation.id}"><i data-lucide="pencil"></i><span>Edit</span></button><button class="secondary-button" type="button" data-admin-guest-action="extend" data-id="${reservation.id}"><i data-lucide="calendar-plus"></i><span>Extend</span></button><button class="row-action admin-checkout-action" type="button" data-admin-guest-action="checkout" data-id="${reservation.id}">Check out</button></div></td>
    </tr>`).join('');
  elements.adminCheckedInEmpty.hidden = checkedIn.length > 0;
  document.querySelector('.admin-guest-table').hidden = checkedIn.length === 0;
  renderAdminActivity();
  if (window.lucide) window.lucide.createIcons();
  if (window.lucide) window.lucide.createIcons();
}

function renderAdminActivity() {
  const activity = [...adminActivity].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  elements.adminActivityRows.innerHTML = activity.map((entry) => `
    <tr>
      <td><span class="activity-time">${escapeHtml(new Date(entry.timestamp).toLocaleString())}</span></td>
      <td><span class="activity-description"><strong>${escapeHtml(entry.action)}</strong><span>${escapeHtml(entry.details)}</span></span></td>
      <td><span class="activity-admin"><strong>${escapeHtml(entry.actor)}</strong><span>${escapeHtml(entry.email)}</span></span></td>
    </tr>`).join('');
  elements.adminActivityEmpty.hidden = activity.length > 0;
  document.querySelector('.admin-activity-table').hidden = activity.length === 0;
}

function logAdminActivity(action, details) {
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : `activity-${Date.now()}`,
    actor: adminProfile.name,
    email: activeAdminEmail,
    action,
    details,
    timestamp: new Date().toISOString()
  };
  adminActivity = [entry, ...adminActivity].slice(0, ADMIN_ACTIVITY_LIMIT);
  renderAdminActivity();
  return apiRequest('/api/activity', { method: 'POST', body: JSON.stringify({ entry }) }).catch((error) => {
    console.error('Administrator activity could not be saved to MySQL.', error);
    showToast(`Activity history could not be saved: ${error.message}`, true);
  });
}

let adminGuestDialogMode = 'edit';

function openAdminGuestDialog(reservation, mode) {
  adminGuestDialogMode = mode;
  elements.adminGuestForm.reset();
  elements.adminGuestError.hidden = true;
  elements.adminGuestId.value = reservation.id;
  elements.adminGuestName.value = reservation.guest;
  elements.adminGuestEmail.value = reservation.email;
  elements.adminGuestPhone.value = '';
  elements.adminGuestPhone.setCustomValidity('');
  if (reservation.phone) {
    const phoneDigits = reservation.phone.replace(/\D/g, '');
    elements.adminGuestPhone.value = phoneDigits.startsWith('63') ? `0${phoneDigits.slice(2)}` : phoneDigits;
  }
  elements.adminGuestFields.hidden = mode === 'extend';
  elements.adminGuestCheckout.value = reservation.checkOut;
  elements.adminGuestCheckout.min = mode === 'extend' ? nextDateKey(reservation.checkOut) : reservation.checkOut;
  elements.adminGuestCheckoutLabel.innerHTML = `${mode === 'extend' ? 'New check-out' : 'Check-out'} <b>*</b>`;
  elements.adminGuestDialogTitle.textContent = mode === 'extend' ? 'Extend stay' : 'Edit guest';
  elements.adminGuestSaveLabel.textContent = mode === 'extend' ? 'Extend stay' : 'Save changes';
  elements.adminGuestRoomNote.textContent = `Room ${reservation.room} · ${reservation.roomType}`;
  elements.adminGuestDialog.showModal();
  if (mode === 'extend') elements.adminGuestCheckout.focus();
  else elements.adminGuestName.focus();
}

function nextDateKey(value) {
  const date = dateFromKey(value);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function handleAdminGuestAction(event) {
  const button = event.target.closest('[data-admin-guest-action]');
  if (!button) return;
  const reservation = reservations.find((booking) => booking.id === button.dataset.id);
  if (!reservation || reservation.status !== 'Checked in') return;

  if (button.dataset.adminGuestAction === 'edit' || button.dataset.adminGuestAction === 'extend') {
    openAdminGuestDialog(reservation, button.dataset.adminGuestAction);
    return;
  }
  if (button.dataset.adminGuestAction !== 'checkout') return;
  if (!window.confirm(`Check out ${reservation.guest}? The reservation history will be kept.`)) return;
  reservation.status = 'Checked out';
  saveReservations();
  logAdminActivity('Guest checked out', `${reservation.guest} checked out of room ${reservation.room}.`);
  render();
  showToast(`${reservation.guest} checked out. Reservation history was kept.`);
}

function handleAdminGuestSubmit(event) {
  event.preventDefault();
  if (!elements.adminGuestForm.reportValidity()) return;
  const reservation = reservations.find((booking) => booking.id === elements.adminGuestId.value);
  if (!reservation || reservation.status !== 'Checked in') {
    elements.adminGuestError.textContent = 'This guest is no longer checked in.';
    elements.adminGuestError.hidden = false;
    return;
  }

  const checkOut = elements.adminGuestCheckout.value;
  if (checkOut <= reservation.checkIn || (checkOut <= localDate() && checkOut !== reservation.checkOut)) {
    elements.adminGuestError.textContent = 'Choose a check-out date after today.';
    elements.adminGuestError.hidden = false;
    return;
  }
  if (!isRoomFree(reservation.room, reservation.checkIn, checkOut, reservation.id)) {
    elements.adminGuestError.textContent = `Room ${reservation.room} is booked during those dates. Choose another check-out date.`;
    elements.adminGuestError.hidden = false;
    return;
  }

  if (adminGuestDialogMode === 'edit') {
    reservation.guest = elements.adminGuestName.value.trim();
    reservation.email = elements.adminGuestEmail.value.trim();
    reservation.phone = formatPhilippinePhone(elements.adminGuestPhone.value);
  }
  const extended = checkOut > reservation.checkOut;
  reservation.checkOut = checkOut;
  saveReservations();
  logAdminActivity(
    extended ? 'Guest stay extended' : 'Guest details updated',
    extended
      ? `${reservation.guest}'s check-out was extended to ${fullDate(checkOut)}.`
      : `Updated ${reservation.guest}'s details in room ${reservation.room}.`
  );
  render();
  elements.adminGuestDialog.close();
  showToast(extended ? `${reservation.guest}'s stay was extended.` : `${reservation.guest}'s details were updated.`);
}

async function handleAdminProfileSubmit(event) {
  event.preventDefault();
  if (!document.querySelector('#admin-profile-form').reportValidity()) return;
  const updatedProfile = {
    name: elements.adminProfileName.value.trim(),
    position: elements.adminProfilePosition.value.trim()
  };
  try {
    adminProfile = await apiRequest('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({ profile: updatedProfile })
    });
  } catch (error) {
    console.error('Administrator profile could not be saved.', error);
    elements.adminProfileStatus.textContent = `Could not save profile: ${error.message}`;
    return;
  }
  adminAccounts = adminAccounts.map((account) => account.email === activeAdminEmail
    ? { ...account, ...adminProfile }
    : account);
  logAdminActivity('Administrator profile updated', 'Updated administrator name and position.');
  renderAdminIdentity();
  elements.adminProfileStatus.textContent = 'Profile saved.';
  showToast('Administrator profile updated.');
}

async function handleAdminAccountSubmit(event) {
  event.preventDefault();
  if (!elements.adminAccountForm.reportValidity()) return;
  const formData = new FormData(elements.adminAccountForm);
  const account = {
    name: String(formData.get('name')).trim(),
    position: String(formData.get('position')).trim(),
    email: String(formData.get('email')).trim().toLowerCase(),
    password: String(formData.get('password'))
  };
  if (!account.name || !account.position) {
    elements.adminAccountStatus.textContent = 'Enter a name and position for this admin.';
    return;
  }
  const emailExists = adminAccounts.some((savedAccount) => savedAccount.email.toLowerCase() === account.email);
  if (emailExists) {
    elements.adminAccountStatus.textContent = 'An admin already uses that email address.';
    elements.adminAccountForm.elements.email.focus();
    return;
  }

  try {
    const savedAccount = await apiRequest('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(account)
    });
    adminAccounts.push(savedAccount);
  } catch (error) {
    console.error('The administrator account could not be created.', error);
    elements.adminAccountStatus.textContent = error.message;
    return;
  }

  elements.adminAccountForm.reset();
  logAdminActivity('Administrator account created', `Created an admin account for ${account.name} (${account.email}).`);
  elements.adminAccountStatus.textContent = 'Admin account created. They can now sign in with this email and password.';
  renderAdminPanel();
  showToast('Administrator account created.');
}

function exportAdminData() {
  const backup = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    property: 'The Aster',
    administrator: adminProfile,
    reservations,
    roomTypes,
    activityHistory: adminActivity
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `the-aster-backup-${localDate()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logAdminActivity('Property backup exported', 'Exported reservations, room inventory, and activity history.');
  showToast('Recovery backup downloaded. Store it somewhere safe.');
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\t\r=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportReservationsCsv() {
  const columns = [
    ['id', 'Reservation ID'],
    ['guest', 'Guest'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['roomType', 'Room type'],
    ['room', 'Room'],
    ['checkIn', 'Check-in'],
    ['checkOut', 'Check-out'],
    ['guests', 'Guests'],
    ['status', 'Status']
  ];
  const rows = [
    columns.map(([, label]) => csvCell(label)).join(','),
    ...reservations.map((reservation) =>
      columns.map(([key]) => csvCell(reservation[key])).join(',')
    )
  ];
  const csv = `\uFEFF${rows.join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `the-aster-reservations-${localDate()}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  logAdminActivity('Reservation CSV exported', `Exported ${reservations.length} reservation records as CSV.`);
  showToast('Reservation CSV downloaded.');
}

function validateBackup(backup) {
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validDate = (value) => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const validStatuses = new Set(['Reserved', 'Checked in', 'Checked out', 'Cancelled']);

  if (!isObject(backup) || backup.property !== 'The Aster' ||
      !Array.isArray(backup.reservations) || !Array.isArray(backup.roomTypes) ||
      !Array.isArray(backup.activityHistory) ||
      !isObject(backup.administrator) ||
      typeof backup.administrator.name !== 'string' || !backup.administrator.name.trim() ||
      typeof backup.administrator.position !== 'string' || !backup.administrator.position.trim()) {
    throw new Error('This file is not a valid The Aster JSON backup.');
  }

  const roomNumbers = new Set();
  const roomTypeNames = new Set();
  for (const type of backup.roomTypes) {
    if (!isObject(type) || typeof type.name !== 'string' || !type.name.trim() ||
        !Array.isArray(type.rooms) || !Number.isFinite(type.rate) || type.rate <= 0 ||
        !Number.isInteger(type.capacity) || type.capacity < 1 ||
        roomTypeNames.has(type.name)) {
      throw new Error('The backup contains an invalid room type. No data was changed.');
    }
    roomTypeNames.add(type.name);
    for (const room of type.rooms) {
      const number = String(room).trim().toUpperCase();
      if (!/^[A-Z0-9-]{1,8}$/.test(number) || roomNumbers.has(number)) {
        throw new Error('The backup contains an invalid or duplicate room number. No data was changed.');
      }
      roomNumbers.add(number);
    }
  }
  if (!backup.roomTypes.length || !roomNumbers.size) {
    throw new Error('The backup must contain at least one room. No data was changed.');
  }

  const reservationIds = new Set();
  for (const reservation of backup.reservations) {
    if (!isObject(reservation) ||
        typeof reservation.id !== 'string' || !reservation.id ||
        reservationIds.has(reservation.id) ||
        typeof reservation.guest !== 'string' || !reservation.guest.trim() ||
        typeof reservation.email !== 'string' || !reservation.email.trim() ||
        (reservation.phone != null && typeof reservation.phone !== 'string') ||
        typeof reservation.roomType !== 'string' ||
        typeof reservation.room !== 'string' ||
        !validDate(reservation.checkIn) || !validDate(reservation.checkOut) ||
        reservation.checkOut <= reservation.checkIn ||
        !Number.isInteger(reservation.guests) || reservation.guests < 1 ||
        !validStatuses.has(reservation.status)) {
      throw new Error('The backup contains an invalid reservation. No data was changed.');
    }
    reservationIds.add(reservation.id);
  }

  for (const entry of backup.activityHistory) {
    if (!isObject(entry) || typeof entry.id !== 'string' ||
        typeof entry.actor !== 'string' || typeof entry.email !== 'string' ||
        typeof entry.action !== 'string' || typeof entry.details !== 'string' ||
        typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) {
      throw new Error('The backup contains an invalid activity record. No data was changed.');
    }
  }
}

async function restoreAdminData(event) {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('Backup files must be 10 MB or smaller.');
    }
    const backup = JSON.parse(await file.text());
    validateBackup(backup);
    if (!window.confirm(`Restore ${backup.reservations.length} reservations, ${backup.roomTypes.reduce((count, type) => count + type.rooms.length, 0)} rooms, and ${backup.activityHistory.length} activity records? This replaces the current records in MySQL.`)) {
      return;
    }

    const nextReservations = backup.reservations.map((reservation) => ({
      ...reservation,
      phone: reservation.phone || ''
    }));
    const nextRoomTypes = backup.roomTypes.map((type) => ({
      ...type,
      rooms: type.rooms.map((room) => String(room).trim().toUpperCase())
    }));
    const nextActivity = backup.activityHistory.slice(0, ADMIN_ACTIVITY_LIMIT);
    const nextProfile = {
      name: backup.administrator.name,
      position: backup.administrator.position
    };
    await saveQueue;
    await apiRequest('/api/restore', {
      method: 'PUT',
      body: JSON.stringify({
        reservations: nextReservations,
        roomTypes: nextRoomTypes,
        activityHistory: nextActivity,
        administrator: nextProfile,
        revision: dataRevision
      })
    });
    await loadServerState();
    logAdminActivity('Property backup restored', `Restored ${reservations.length} reservations and ${allRooms.length} rooms from ${file.name}.`);
    showToast('Backup restored successfully.');
  } catch (error) {
    console.error('The selected backup could not be restored.', error);
    showToast(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message || 'Backup could not be restored.', true);
  } finally {
    input.value = '';
  }
}

let overviewMenuExpanded = false;
let administratorMenuExpanded = false;
let administratorUnlocked = false;
let administratorIdleTimer;
let administratorIdleDeadline = 0;
let administratorLockMode = 'unlock';
const activeViewSections = { overview: 'overview-dashboard', analytics: 'analytics-metrics' };
let activeAdminSection = 'admin-profile-panel';

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) {
    throw new Error('Administrator lock settings are invalid. They cannot be reset from this screen.');
  }
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function deriveAdministratorPasswordHash(password, salt) {
  if (!window.crypto?.subtle) throw new Error('Secure password storage is unavailable in this browser.');
  const passwordKey = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    passwordKey,
    256
  );
  return bytesToHex(new Uint8Array(hash));
}

function readAdministratorLock() {
  let saved;
  try {
    saved = localStorage.getItem(ADMIN_LOCK_KEY);
  } catch (error) {
    throw new Error('Administrator password settings could not be read in this browser.');
  }
  if (saved === null) return null;

  let record;
  try {
    record = JSON.parse(saved);
  } catch {
    throw new Error('Administrator lock settings are damaged. The password cannot be reset from this screen.');
  }
  if (!record || record.version !== 1 || typeof record.salt !== 'string' ||
      typeof record.hash !== 'string' || !/^[0-9a-f]{32}$/i.test(record.salt) ||
      !/^[0-9a-f]{64}$/i.test(record.hash)) {
    throw new Error('Administrator lock settings are damaged. The password cannot be reset from this screen.');
  }
  return record;
}

function openAdministratorLock() {
  const dialog = document.querySelector('#administrator-lock-dialog');
  const form = document.querySelector('#administrator-lock-form');
  const error = document.querySelector('#administrator-lock-error');
  const confirmField = document.querySelector('#administrator-lock-confirm-field');
  const password = document.querySelector('#administrator-lock-password');
  try {
    administratorLockMode = readAdministratorLock() ? 'unlock' : 'setup';
  } catch (lockError) {
    showToast(lockError.message, true);
    return;
  }
  form.reset();
  error.hidden = true;
  confirmField.hidden = administratorLockMode !== 'setup';
  document.querySelector('#administrator-lock-title').textContent =
    administratorLockMode === 'setup' ? 'Set an Administrator password' : 'Unlock Administrator';
  document.querySelector('#administrator-lock-description').textContent =
    administratorLockMode === 'setup'
      ? 'Create a separate password for this section. It locks again after 15 minutes of inactivity.'
      : 'Enter the separate password to open the Administrator section.';
  document.querySelector('#administrator-lock-submit-label').textContent =
    administratorLockMode === 'setup' ? 'Set password and continue' : 'Unlock';
  password.autocomplete = administratorLockMode === 'setup' ? 'new-password' : 'current-password';
  dialog.showModal();
  password.focus();
}

function resetAdministratorIdleTimer() {
  if (!administratorUnlocked) return;
  clearTimeout(administratorIdleTimer);
  administratorIdleDeadline = Date.now() + ADMIN_LOCK_IDLE_MS;
  administratorIdleTimer = setTimeout(() => {
    lockAdministratorArea();
  }, ADMIN_LOCK_IDLE_MS);
}

function lockAdministratorArea() {
  if (!administratorUnlocked) return;
  administratorUnlocked = false;
  administratorIdleDeadline = 0;
  clearTimeout(administratorIdleTimer);
  administratorMenuExpanded = false;
  const activePage = document.querySelector('[data-page-view]:not([hidden])')?.dataset.pageView || 'overview';
  if (activePage === 'administrator') {
    showWorkflowView('overview');
    showToast('Administrator section locked after 15 minutes of inactivity.');
  } else {
    showWorkflowView(activePage);
  }
}

async function handleAdministratorLockSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const password = document.querySelector('#administrator-lock-password').value;
  const confirmation = document.querySelector('#administrator-lock-confirm-password').value;
  const error = document.querySelector('#administrator-lock-error');
  const submit = form.querySelector('[type="submit"]');
  error.hidden = true;

  if (password.length < 8) {
    error.textContent = 'Use at least 8 characters.';
    error.hidden = false;
    return;
  }
  if (password.length > 128) {
    error.textContent = 'Use no more than 128 characters.';
    error.hidden = false;
    return;
  }
  if (administratorLockMode === 'setup' && password !== confirmation) {
    error.textContent = 'The passwords do not match.';
    error.hidden = false;
    return;
  }

  submit.disabled = true;
  try {
    if (administratorLockMode === 'setup') {
      if (readAdministratorLock()) {
        throw new Error('An Administrator password has already been set. Unlock the section instead.');
      }
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const record = {
        version: 1,
        salt: bytesToHex(salt),
        hash: await deriveAdministratorPasswordHash(password, salt)
      };
      localStorage.setItem(ADMIN_LOCK_KEY, JSON.stringify(record));
    } else {
      const record = readAdministratorLock();
      if (!record) throw new Error('Administrator password has not been set. Set it up to continue.');
      const expected = hexToBytes(record.hash);
      const actual = hexToBytes(await deriveAdministratorPasswordHash(password, hexToBytes(record.salt)));
      const matches = actual.length === expected.length &&
        actual.reduce((difference, byte, index) => difference | (byte ^ expected[index]), 0) === 0;
      if (!matches) throw new Error('That Administrator password is incorrect.');
    }

    administratorUnlocked = true;
    document.querySelector('#administrator-lock-dialog').close();
    form.reset();
    administratorMenuExpanded = true;
    resetAdministratorIdleTimer();
    showWorkflowView('administrator');
  } catch (lockError) {
    console.error('Administrator access could not be unlocked.', lockError);
    error.textContent = lockError.message || 'Could not unlock Administrator.';
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

function showViewSection(viewName) {
  const sectionId = activeViewSections[viewName];
  const sections = [...document.querySelectorAll(`[data-view-section="${viewName}"]`)];
  const activeSection = sections.find((section) => section.id === sectionId);
  if (!activeSection) return;
  sections.forEach((section) => {
    section.hidden = section !== activeSection;
  });
  document.querySelectorAll('[data-view-section-link]').forEach((link) => {
    const active = link.dataset.viewSectionLink === sectionId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

function showAdminSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section || !section.matches('[data-admin-panel]')) return;
  activeAdminSection = sectionId;
  document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
    panel.hidden = panel !== section;
  });
  document.querySelector('#admin-profile-grid').dataset.singleSection = 'true';
  document.querySelectorAll('[data-admin-section]').forEach((link) => {
    const active = link.dataset.adminSection === sectionId;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}

function showWorkflowView(viewName) {
  const labels = { overview: 'OVERVIEW', reservations: 'RESERVATIONS', rooms: 'ROOMS', guests: 'GUESTS', analytics: 'ANALYTICS', administrator: 'ADMINISTRATOR' };
  const activeView = labels[viewName] ? viewName : 'overview';
  if (activeView === 'administrator' && !administratorUnlocked) {
    openAdministratorLock();
    return;
  }
  const activeNavView = activeView === 'analytics' ? 'overview' : activeView;
  if (activeNavView !== 'overview') overviewMenuExpanded = false;
  if (activeView !== 'administrator') administratorMenuExpanded = false;
  document.querySelectorAll('[data-page-view]').forEach((view) => {
    view.hidden = view.dataset.pageView !== activeView;
  });
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.dataset.viewNav === activeNavView;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  [
    { view: 'overview', expanded: overviewMenuExpanded },
    { view: 'administrator', expanded: administratorMenuExpanded }
  ].forEach(({ view, expanded }) => {
    const isExpanded = activeNavView === view && expanded;
    document.querySelector(`[data-view-nav="${view}"]`).setAttribute('aria-expanded', String(isExpanded));
    document.querySelector(`#${view}-subnav`).hidden = !isExpanded;
    document.querySelector(`#${view}-nav-group`).classList.toggle('expanded', isExpanded);
  });
  if (activeView === 'overview' || activeView === 'analytics') showViewSection(activeView);
  if (activeView === 'administrator') showAdminSection(activeAdminSection);
  document.querySelector('#current-view-label').textContent = labels[activeView];
}

function renderDashboard() {
  const today = localDate();
  const active = reservations.filter((reservation) => reservation.status !== 'Cancelled');
  const arrivals = active.filter((reservation) => reservation.checkIn === today && reservation.status === 'Reserved');
  const departures = active.filter((reservation) => reservation.checkOut === today && reservation.status === 'Checked in');
  const inHouseRooms = new Set(active.filter((reservation) => reservation.status === 'Checked in' && reservation.checkIn <= today && reservation.checkOut > today).map((reservation) => reservation.room));
  const occupiedTonight = new Set(active.filter((reservation) => reservation.checkIn <= today && reservation.checkOut > today).map((reservation) => reservation.room));
  const availableTonight = allRooms.length - occupiedTonight.size;
  const occupancy = Math.round((inHouseRooms.size / allRooms.length) * 100);

  document.querySelector('#today-date').textContent = fullDate(today);
  document.querySelector('#welcome-date').textContent = `Today, ${fullDate(today)}`;
  renderAdminIdentity();
  document.querySelector('#arrivals-count').textContent = arrivals.length;
  document.querySelector('#arrivals-note').textContent = arrivals.length ? `${arrivals.reduce((sum, booking) => sum + Number(booking.guests), 0)} guests expected` : 'No arrivals just yet';
  document.querySelector('#departures-count').textContent = departures.length;
  document.querySelector('#occupancy-count').textContent = inHouseRooms.size;
  document.querySelector('#room-total').textContent = allRooms.length;
  document.querySelector('#available-count').textContent = availableTonight;
  document.querySelector('#available-total').textContent = allRooms.length;
  document.querySelector('#property-room-total').textContent = allRooms.length;
  document.querySelector('#occupancy-bar').style.width = `${occupancy}%`;
  document.querySelector('.occupancy-track').setAttribute('aria-valuenow', occupancy);
  renderRoomAvailability();
}

function currency(value) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(value);
}

function renderAnalytics() {
  const days = Number(document.querySelector('#analytics-range').value) || 30;
  const today = localDate();
  const endDate = localDate(days);
  const activeReservations = reservations.filter((reservation) => reservation.status !== 'Cancelled');
  const upcomingArrivals = activeReservations.filter((reservation) => reservation.checkIn >= today && reservation.checkIn < endDate);
  const roomRevenue = roomTypes.map((type) => {
    const revenue = activeReservations.reduce((total, reservation) => {
      if (reservation.roomType !== type.name) return total;
      const overlapStart = reservation.checkIn > today ? reservation.checkIn : today;
      const overlapEnd = reservation.checkOut < endDate ? reservation.checkOut : endDate;
      return overlapStart < overlapEnd ? total + nightsBetween(overlapStart, overlapEnd) * type.rate : total;
    }, 0);
    return { name: type.name, revenue };
  });
  const forecastRevenue = roomRevenue.reduce((total, roomType) => total + roomType.revenue, 0);
  let occupiedRoomNights = 0;

  for (let offset = 0; offset < days; offset += 1) {
    const date = localDate(offset);
    const occupiedRooms = new Set(activeReservations
      .filter((reservation) => reservation.checkIn <= date && reservation.checkOut > date)
      .map((reservation) => reservation.room));
    occupiedRoomNights += occupiedRooms.size;
  }

  const averageOccupancy = allRooms.length && days ? Math.round((occupiedRoomNights / (allRooms.length * days)) * 100) : 0;
  const periodLabel = `Next ${days} days`;
  document.querySelector('#analytics-revenue').textContent = currency(forecastRevenue);
  document.querySelector('#analytics-revenue-note').textContent = periodLabel;
  document.querySelector('#analytics-arrivals').textContent = upcomingArrivals.length;
  document.querySelector('#analytics-arrivals-note').textContent = periodLabel;
  document.querySelector('#analytics-occupancy').textContent = `${averageOccupancy}%`;
  document.querySelector('#analytics-occupancy-note').textContent = `Across ${days} nights`;
  document.querySelector('#revenue-chart-period').textContent = periodLabel;

  const maxRevenue = Math.max(1, ...roomRevenue.map((item) => item.revenue));
  document.querySelector('#revenue-chart').innerHTML = roomRevenue.map((item) => `
    <div class="revenue-row" role="listitem">
      <div class="revenue-row-heading"><strong>${escapeHtml(item.name)}</strong><span>${currency(item.revenue)}</span></div>
      <div class="revenue-bar-track" role="img" aria-label="${escapeHtml(item.name)} forecast ${currency(item.revenue)}"><span style="width: ${(item.revenue / maxRevenue) * 100}%"></span></div>
    </div>`).join('');
}

function renderRoomAvailability() {
  const tonight = localDate();
  const tomorrow = localDate(1);
  document.querySelector('#room-list').innerHTML = roomTypes.map((type) => {
    const freeCount = freeRooms(type.name, tonight, tomorrow).length;
    const capacityLabel = `${type.capacity} ${type.capacity === 1 ? 'guest' : 'guests'} · ${currency(type.rate)}/night`;
    return `<div class="room-type-row"><span class="room-type-copy"><strong>${escapeHtml(type.name)}</strong><span>${capacityLabel}</span></span><span class="room-type-availability ${freeCount ? '' : 'none'}">${freeCount} / ${type.rooms.length}</span></div>`;
  }).join('');
}

function roomHasActiveBooking(roomNumber) {
  const today = localDate();
  return reservations.some((reservation) => reservation.room === roomNumber && reservation.status !== 'Cancelled' && reservation.status !== 'Checked out' && reservation.checkOut >= today);
}

function renderManagedRooms() {
  const today = localDate();
  const tomorrow = localDate(1);
  const sortedRooms = [...allRooms].sort((left, right) => left.number.localeCompare(right.number, undefined, { numeric: true }));
  elements.roomsManagerSummary.textContent = `${sortedRooms.length} ${sortedRooms.length === 1 ? 'room' : 'rooms'} · ${roomTypes.length} room types`;
  elements.roomManagerList.innerHTML = sortedRooms.map((room) => {
    const activeBooking = reservations.find((reservation) => reservation.room === room.number && reservation.status !== 'Cancelled' && reservation.status !== 'Checked out' && reservation.checkOut > today);
    const occupied = activeBooking?.status === 'Checked in' && activeBooking.checkIn <= today;
    const reserved = activeBooking && activeBooking.checkIn < tomorrow;
    const state = occupied ? 'Occupied' : reserved ? 'Reserved' : 'Ready';
    const locked = roomHasActiveBooking(room.number);
    const lockHint = locked ? ' title="Room has a current or upcoming reservation"' : '';
    return `<article class="managed-room-row">
      <strong class="managed-room-number">${escapeHtml(room.number)}</strong>
      <span class="managed-room-type"><strong>${escapeHtml(room.name)}</strong><span>${room.capacity} ${room.capacity === 1 ? 'guest' : 'guests'} · ${currency(room.rate)}/night</span></span>
      <span class="room-state room-state-${state.toLowerCase()}">${state}</span>
      <span class="managed-room-actions"><button class="icon-button room-row-action" type="button" data-room-action="edit" data-room-number="${escapeHtml(room.number)}" aria-label="Edit room ${escapeHtml(room.number)}" title="Edit room"${locked ? ' disabled' : ''}><i data-lucide="pencil"></i></button><button class="icon-button room-row-action remove-room-action" type="button" data-room-action="remove" data-room-number="${escapeHtml(room.number)}" aria-label="Remove room ${escapeHtml(room.number)}" title="Remove room"${locked || allRooms.length <= 1 ? ' disabled' : ''}${lockHint}><i data-lucide="trash-2"></i></button></span>
    </article>`;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
}

function openRoomsManager() {
  renderManagedRooms();
  elements.roomsDialog.showModal();
}

function openRoomForm(room = null) {
  elements.roomForm.reset();
  elements.roomFormError.hidden = true;
  elements.managedRoomType.innerHTML = roomTypes.map((type) => `<option value="${escapeHtml(type.name)}">${escapeHtml(type.name)}</option>`).join('');
  elements.originalRoomNumber.value = room?.number || '';
  elements.roomNumber.value = room?.number || '';
  elements.managedRoomType.value = room?.name || roomTypes[0].name;
  const action = room ? 'Save room' : 'Add room';
  elements.roomEditTitle.textContent = room ? 'Edit room' : 'Add room';
  elements.saveRoomLabel.textContent = action;
  elements.roomEditDialog.showModal();
  elements.roomNumber.focus();
}

function handleRoomFormSubmit(event) {
  event.preventDefault();
  if (!elements.roomForm.reportValidity()) return;
  const formData = new FormData(elements.roomForm);
  const originalNumber = String(formData.get('originalNumber')).trim().toUpperCase();
  const number = String(formData.get('roomNumber')).trim().toUpperCase();
  const typeName = String(formData.get('roomType'));
  const duplicate = allRooms.some((room) => room.number.toUpperCase() === number && room.number.toUpperCase() !== originalNumber);

  if (duplicate) {
    elements.roomFormError.textContent = `Room ${number} already exists.`;
    elements.roomFormError.hidden = false;
    elements.roomNumber.focus();
    return;
  }

  if (originalNumber && roomHasActiveBooking(originalNumber)) {
    elements.roomFormError.textContent = 'This room has a current or upcoming reservation and cannot be changed yet.';
    elements.roomFormError.hidden = false;
    return;
  }

  if (originalNumber) {
    const previousType = roomTypes.find((type) => type.rooms.includes(originalNumber));
    if (previousType) previousType.rooms = previousType.rooms.filter((room) => room !== originalNumber);
  }
  const nextType = roomTypes.find((type) => type.name === typeName);
  if (!nextType) return;
  nextType.rooms.push(number);
  saveRoomTypes();
  rebuildRoomInventory();
  logAdminActivity(
    originalNumber ? 'Room updated' : 'Room added',
    originalNumber
      ? `Updated room ${originalNumber} to ${number} (${typeName}).`
      : `Added room ${number} (${typeName}).`
  );
  render();
  renderManagedRooms();
  elements.roomEditDialog.close();
  showToast(originalNumber ? `Room ${number} updated.` : `Room ${number} added.`);
}

function handleRoomManagerAction(event) {
  const button = event.target.closest('[data-room-action]');
  if (!button) return;
  const roomNumber = button.dataset.roomNumber;
  const room = allRooms.find((entry) => entry.number === roomNumber);
  if (!room) return;

  if (roomHasActiveBooking(roomNumber)) {
    showToast(`Room ${roomNumber} has a current or upcoming reservation.`, true);
    renderManagedRooms();
    return;
  }

  if (button.dataset.roomAction === 'edit') {
    openRoomForm(room);
    return;
  }

  if (button.dataset.roomAction !== 'remove' || allRooms.length <= 1) return;
  if (!window.confirm(`Remove room ${roomNumber} from the property?`)) return;
  const roomType = roomTypes.find((type) => type.name === room.name);
  roomType.rooms = roomType.rooms.filter((number) => number !== roomNumber);
  saveRoomTypes();
  rebuildRoomInventory();
  logAdminActivity('Room removed', `Removed room ${roomNumber} (${room.name}).`);
  render();
  renderManagedRooms();
  showToast(`Room ${roomNumber} removed.`);
}

function render() {
  renderDashboard();
  renderReservations();
  renderGuests();
  renderAnalytics();
  renderAdminPanel();
}

function updateAvailability() {
  const checkIn = elements.checkIn.value;
  const checkOut = elements.checkOut.value;
  const type = elements.roomType.value;
  const typeDetails = roomTypes.find((room) => room.name === type);
  const message = elements.availability;
  const datesValid = checkIn && checkOut && checkOut > checkIn;

  if (!datesValid) {
    message.classList.remove('unavailable');
    message.innerHTML = '<i data-lucide="calendar-days"></i><span>Select your dates to see room availability.</span>';
    elements.submit.disabled = true;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  if (Number(elements.guests.value) > typeDetails.capacity) {
    message.classList.add('unavailable');
    message.innerHTML = `<i data-lucide="circle-alert"></i><span>${escapeHtml(type)} accommodates up to ${typeDetails.capacity} ${typeDetails.capacity === 1 ? 'guest' : 'guests'}.</span>`;
    elements.submit.disabled = true;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const rooms = freeRooms(type, checkIn, checkOut);
  const nights = nightsBetween(checkIn, checkOut);
  message.classList.toggle('unavailable', rooms.length === 0);
  message.innerHTML = rooms.length
    ? `<i data-lucide="check-circle-2"></i><span>${rooms.length} ${type === 'The Aster Penthouse' ? 'room' : 'rooms'} available · ${currency(typeDetails.rate * nights)} total for ${nights} ${nights === 1 ? 'night' : 'nights'}</span>`
    : '<i data-lucide="circle-alert"></i><span>No rooms of this type are free for these dates.</span>';
  elements.submit.disabled = rooms.length === 0;
  if (window.lucide) window.lucide.createIcons();
}

function openBookingDialog() {
  const form = elements.form;
  form.reset();
  elements.phone.setCustomValidity('');
  elements.checkIn.min = localDate();
  elements.checkIn.value = localDate(1);
  elements.checkOut.min = localDate(2);
  elements.checkOut.value = localDate(2);
  elements.roomType.innerHTML = roomTypes.map((type) => `<option value="${escapeHtml(type.name)}">${escapeHtml(type.name)} · ${currency(type.rate)}/night</option>`).join('');
  updateAvailability();
  elements.dialog.showModal();
  form.elements.guest.focus();
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('show');
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 2900);
}

function handleBookingSubmit(event) {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;
  const formData = new FormData(elements.form);
  const checkIn = String(formData.get('checkIn'));
  const checkOut = String(formData.get('checkOut'));
  const roomType = String(formData.get('roomType'));
  const guests = Number(formData.get('guests'));
  const typeDetails = roomTypes.find((room) => room.name === roomType);

  if (checkIn < localDate() || checkOut <= checkIn) {
    showToast('Choose a future check-in and a later check-out.', true);
    return;
  }

  if (guests > typeDetails.capacity) {
    updateAvailability();
    showToast(`${roomType} accommodates up to ${typeDetails.capacity} ${typeDetails.capacity === 1 ? 'guest' : 'guests'}.`, true);
    return;
  }

  const assignedRoom = freeRooms(roomType, checkIn, checkOut)[0];
  if (!assignedRoom) {
    updateAvailability();
    showToast('That room type is no longer available for those dates.', true);
    return;
  }

  reservations.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `booking-${Date.now()}`,
    guest: String(formData.get('guest')).trim(),
    email: String(formData.get('email')).trim(),
    phone: formatPhilippinePhone(formData.get('phone')),
    checkIn,
    checkOut,
    roomType,
    room: assignedRoom.number,
    guests,
    status: 'Reserved'
  });
  saveReservations();
  logAdminActivity('Reservation created', `Created a reservation for ${String(formData.get('guest')).trim()} in room ${assignedRoom.number}.`);
  render();
  elements.dialog.close();
  showToast(`${String(formData.get('guest')).trim()} is booked in room ${assignedRoom.number}.`);
}

function handleReservationAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const reservation = reservations.find((booking) => booking.id === button.dataset.id);
  if (!reservation) return;

  let activityAction;
  let activityDetails;
  switch (button.dataset.action) {
    case 'check-in':
      reservation.status = 'Checked in';
      activityAction = 'Guest checked in';
      activityDetails = `${reservation.guest} checked in to room ${reservation.room}.`;
      showToast(`${reservation.guest} has checked in.`);
      break;
    case 'check-out':
      reservation.status = 'Checked out';
      activityAction = 'Guest checked out';
      activityDetails = `${reservation.guest} checked out of room ${reservation.room}.`;
      showToast(`${reservation.guest} has checked out.`);
      break;
    case 'cancel':
      reservation.status = 'Cancelled';
      activityAction = 'Reservation cancelled';
      activityDetails = `Cancelled ${reservation.guest}'s reservation for room ${reservation.room}.`;
      showToast(`${reservation.guest}'s reservation was cancelled.`);
      break;
    case 'delete':
      reservations = reservations.filter((booking) => booking.id !== reservation.id);
      activityAction = 'Reservation removed';
      activityDetails = `Removed the cancelled reservation for ${reservation.guest}.`;
      showToast('Cancelled reservation removed.');
      break;
    default:
      return;
  }
  saveReservations();
  logAdminActivity(activityAction, activityDetails);
  render();
}

function showDashboard() {
  elements.login.hidden = true;
  elements.appShell.hidden = false;
  if (window.lucide) window.lucide.createIcons();
}

function showAdminLogin() {
  elements.appShell.hidden = true;
  elements.login.hidden = false;
  elements.loginPassword.value = '';
  elements.loginError.hidden = true;
  if (window.lucide) window.lucide.createIcons();
}

async function handleAdminLogin(event) {
  event.preventDefault();
  const email = elements.loginEmail.value.trim().toLowerCase();
  const password = elements.loginPassword.value;
  const submit = elements.loginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { admin } = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    activeAdminEmail = admin.email;
    await loadServerState();
    elements.loginError.hidden = true;
    showDashboard();
    logAdminActivity('Administrator signed in', 'Signed in to the admin portal.');
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.loginError.hidden = false;
    elements.loginPassword.select();
  } finally {
    submit.disabled = false;
  }
}

async function handleAdminLogout() {
  administratorUnlocked = false;
  administratorMenuExpanded = false;
  administratorIdleDeadline = 0;
  clearTimeout(administratorIdleTimer);
  try {
    await logAdminActivity('Administrator signed out', 'Signed out of the admin portal.');
    await apiRequest('/api/auth/logout', { method: 'POST' });
  } catch (error) {
    console.error('The admin session could not be cleared.', error);
    showToast(`Sign out failed: ${error.message}`, true);
    return;
  }
  showAdminLogin();
  elements.loginEmail.focus();
}

function applyTheme(theme) {
  const mode = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (error) {
    console.warn('The theme preference could not be saved.', error);
  }

  const isDark = mode === 'dark';
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    const action = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    button.setAttribute('aria-label', action);
    button.setAttribute('title', action);
    button.setAttribute('aria-pressed', String(isDark));
    const icon = `<i data-lucide="${isDark ? 'sun' : 'moon'}"></i>`;
    button.innerHTML = button.classList.contains('sidebar-theme-toggle')
      ? `${icon}<span class="theme-mode-label">${isDark ? 'Light mode' : 'Dark mode'}</span>`
      : icon;
  });
  if (window.lucide) window.lucide.createIcons();
}

async function initialize() {
  showViewSection('overview');
  showViewSection('analytics');
  elements.adminProfileName.value = adminProfile.name;
  elements.adminProfilePosition.value = adminProfile.position;
  elements.adminAccountForm.addEventListener('submit', handleAdminAccountSubmit);
  document.querySelector('#admin-profile-form').addEventListener('submit', handleAdminProfileSubmit);
  document.querySelector('#admin-manage-rooms').addEventListener('click', openRoomsManager);
  document.querySelector('#export-admin-data').addEventListener('click', exportAdminData);
  document.querySelector('#export-reservations-csv').addEventListener('click', exportReservationsCsv);
  document.querySelector('#restore-admin-data').addEventListener('click', () => {
    document.querySelector('#restore-admin-data-file').click();
  });
  document.querySelector('#restore-admin-data-file').addEventListener('change', restoreAdminData);
  elements.adminCheckedInRows.addEventListener('click', handleAdminGuestAction);
  elements.adminGuestForm.addEventListener('submit', handleAdminGuestSubmit);
  elements.adminGuestPhone.addEventListener('input', () => sanitizePhilippinePhoneInput(elements.adminGuestPhone));
  document.querySelectorAll('[data-close-admin-guest]').forEach((button) => button.addEventListener('click', () => elements.adminGuestDialog.close()));
  elements.adminGuestDialog.addEventListener('click', (event) => {
    if (event.target === elements.adminGuestDialog) elements.adminGuestDialog.close();
  });
  let savedTheme = 'light';
  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
  } catch (error) {
    console.warn('The saved theme preference could not be read.', error);
  }
  applyTheme(savedTheme);
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
    });
  });
  elements.loginForm.addEventListener('submit', handleAdminLogin);
  document.querySelector('#logout-button').addEventListener('click', handleAdminLogout);
  document.querySelector('#administrator-lock-form').addEventListener('submit', handleAdministratorLockSubmit);
  document.querySelector('#administrator-lock-cancel').addEventListener('click', () => {
    document.querySelector('#administrator-lock-dialog').close();
  });
  document.querySelector('#administrator-lock-dialog').addEventListener('close', () => {
    document.querySelector('#administrator-lock-form').reset();
    document.querySelector('#administrator-lock-error').hidden = true;
  });
  document.querySelector('#toggle-password').addEventListener('click', (event) => {
    const button = event.currentTarget;
    const reveal = elements.loginPassword.type === 'password';
    elements.loginPassword.type = reveal ? 'text' : 'password';
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', String(reveal));
    button.innerHTML = `<i data-lucide="${reveal ? 'eye-off' : 'eye'}"></i>`;
    if (window.lucide) window.lucide.createIcons();
  });
  document.querySelectorAll('[data-open-booking]').forEach((button) => button.addEventListener('click', openBookingDialog));
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => elements.dialog.close()));
  elements.form.addEventListener('submit', handleBookingSubmit);
  elements.rows.addEventListener('click', handleReservationAction);
  elements.search.addEventListener('input', () => {
    reservationPage = 1;
    renderReservations();
  });
  elements.filter.addEventListener('change', () => {
    reservationPage = 1;
    renderReservations();
  });
  elements.pagination.addEventListener('click', handleReservationPagination);
  elements.checkIn.addEventListener('change', () => {
    const nextDay = new Date(`${elements.checkIn.value}T12:00:00`);
    nextDay.setDate(nextDay.getDate() + 1);
    elements.checkOut.min = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
    if (elements.checkOut.value <= elements.checkIn.value) elements.checkOut.value = elements.checkOut.min;
    updateAvailability();
  });
  elements.checkOut.addEventListener('change', updateAvailability);
  elements.roomType.addEventListener('change', updateAvailability);
  elements.guests.addEventListener('change', updateAvailability);
  elements.phone.addEventListener('input', () => sanitizePhilippinePhoneInput(elements.phone));
  document.querySelector('#analytics-range').addEventListener('change', renderAnalytics);
  elements.guestSearch.addEventListener('input', renderGuests);
  document.querySelectorAll('[data-view-nav]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const view = link.dataset.viewNav;
    if (view === 'administrator' && !administratorUnlocked) {
      openAdministratorLock();
      return;
    }
    const expandedMenus = {
      overview: overviewMenuExpanded,
      administrator: administratorMenuExpanded
    };
    if (Object.hasOwn(expandedMenus, view)) {
      const currentNavView = !document.querySelector('#view-analytics').hidden ? 'overview' : view;
      const isViewVisible = !document.querySelector(`#view-${currentNavView}`).hidden;
      const nextExpandedState = isViewVisible ? !expandedMenus[view] : true;
      if (view === 'overview') overviewMenuExpanded = nextExpandedState;
      if (view === 'administrator') administratorMenuExpanded = nextExpandedState;
    }
    showWorkflowView(view);
  }));
  document.querySelectorAll('[data-view-section-link]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    const section = document.getElementById(link.dataset.viewSectionLink);
    const view = section?.dataset.viewSection;
    if (!view || !Object.hasOwn(activeViewSections, view)) return;
    activeViewSections[view] = section.id;
    overviewMenuExpanded = true;
    showWorkflowView(view);
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.querySelectorAll('[data-admin-section]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    activeAdminSection = link.dataset.adminSection;
    if (!administratorUnlocked) {
      openAdministratorLock();
      return;
    }
    administratorMenuExpanded = true;
    showWorkflowView('administrator');
    document.querySelector(`#${link.dataset.adminSection}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (administratorUnlocked) resetAdministratorIdleTimer();
    }, { passive: eventName !== 'keydown' });
  });
  document.addEventListener('visibilitychange', () => {
    if (!administratorUnlocked || document.visibilityState !== 'visible') return;
    if (Date.now() >= administratorIdleDeadline) lockAdministratorArea();
    else resetAdministratorIdleTimer();
  });
  document.querySelector('#room-refresh').addEventListener('click', () => {
    renderRoomAvailability();
    showToast('Room availability is up to date.');
  });
  document.querySelector('#open-room-manager').addEventListener('click', openRoomsManager);
  document.querySelector('#add-room-button').addEventListener('click', () => openRoomForm());
  document.querySelectorAll('[data-close-rooms]').forEach((button) => button.addEventListener('click', () => elements.roomsDialog.close()));
  document.querySelectorAll('[data-close-room-form]').forEach((button) => button.addEventListener('click', () => elements.roomEditDialog.close()));
  elements.roomManagerList.addEventListener('click', handleRoomManagerAction);
  elements.roomForm.addEventListener('submit', handleRoomFormSubmit);
  elements.roomsDialog.addEventListener('click', (event) => {
    if (event.target === elements.roomsDialog) elements.roomsDialog.close();
  });
  elements.roomEditDialog.addEventListener('click', (event) => {
    if (event.target === elements.roomEditDialog) elements.roomEditDialog.close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !elements.dialog.open) {
      event.preventDefault();
      elements.search.focus();
    }
  });
  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) elements.dialog.close();
  });
  try {
    const { admin } = await apiRequest('/api/auth/session');
    if (!admin) {
      showAdminLogin();
      return;
    }
    activeAdminEmail = admin.email;
    await loadServerState();
    showDashboard();
  } catch (error) {
    console.error('The admin session could not be restored.', error);
    showAdminLogin();
    elements.loginError.textContent = `Could not connect to the application server: ${error.message}`;
    elements.loginError.hidden = false;
  }
}

initialize();