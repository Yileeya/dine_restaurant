// 對應規格書 Rules 工作表；改規則時同步改這裡與規格書
export const SLOTS = ['11:30', '12:30', '17:30', '18:30'] as const; // BR-05
export const MAX_GUESTS = 10;        // BR-03
export const SLOT_CAPACITY = 20;     // BR-06
export const BOOKING_WINDOW_DAYS = 30; // BR-04：D+1 ~ D+30
export const PHONE_PATTERN = /^09\d{8}$/; // BR-02
export const TZ_OFFSET_HOURS = 8;    // 以台灣時間判斷「今天」
