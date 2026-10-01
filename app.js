App({
  onLaunch() {
    // 初始化存储
    const data = wx.getStorageSync('cycle_data');
    if (!data) {
      wx.setStorageSync('cycle_data', {
        markedDates: [],
        avgCycleLength: 28,
        avgPeriodLength: 5,
        customCycleLength: null,
        customPeriodLength: null,
      });
    }
  },
});
