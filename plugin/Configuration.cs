using System;
using Dalamud.Configuration;

namespace FcEventCalendar;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 1;
    public string ServerUrl { get; set; } = "https://fc-event-calendar.yourfc-calendar.workers.dev";
    public string DeviceToken { get; set; } = "";
    public string MemberId { get; set; } = "";
    public bool RemindersEnabled { get; set; } = true;
    public int ReminderMinutesBefore { get; set; } = 30;
    public bool PlayReminderSound { get; set; } = true;

    public void Save() => Plugin.PluginInterface.SavePluginConfig(this);
}
