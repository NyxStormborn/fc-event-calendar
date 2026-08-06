using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Json;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;
using Dalamud.Game.Command;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;

namespace FcEventCalendar;

public sealed class Plugin : IDalamudPlugin
{
    [PluginService] internal static IDalamudPluginInterface PluginInterface { get; private set; } = null!;
    [PluginService] internal static ICommandManager CommandManager { get; private set; } = null!;
    [PluginService] internal static IPlayerState PlayerState { get; private set; } = null!;
    [PluginService] internal static IFramework Framework { get; private set; } = null!;

    internal Configuration Configuration { get; }
    internal HttpClient Http { get; } = new();
    private readonly WindowSystem windows = new("FcEventCalendar");
    private readonly CalendarWindow mainWindow;

    public Plugin()
    {
        Configuration = PluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
        mainWindow = new CalendarWindow(this);
        windows.AddWindow(mainWindow);
        CommandManager.AddHandler("/fcevents", new CommandInfo((_, _) => mainWindow.Toggle()) { HelpMessage = "Opens the FC Event Calendar." });
        PluginInterface.UiBuilder.Draw += windows.Draw;
        Framework.Update += mainWindow.UpdateReminders;
        PluginInterface.UiBuilder.OpenMainUi += mainWindow.Toggle;
        PluginInterface.UiBuilder.OpenConfigUi += mainWindow.Toggle;
    }

    public void Dispose()
    {
        PluginInterface.UiBuilder.Draw -= windows.Draw;
        Framework.Update -= mainWindow.UpdateReminders;
        PluginInterface.UiBuilder.OpenMainUi -= mainWindow.Toggle;
        PluginInterface.UiBuilder.OpenConfigUi -= mainWindow.Toggle;
        CommandManager.RemoveHandler("/fcevents");
        windows.RemoveAllWindows();
        Http.Dispose();
    }
}

public sealed class CalendarWindow : Window
{
    private readonly Plugin plugin;
    private readonly JsonSerializerOptions json = new() { PropertyNameCaseInsensitive = true };
    private string accessCode = "";
    private string title = "";
    private string description = "";
    private int eventDay;
    private int eventMonth;
    private int eventYear;
    private int eventHour;
    private int eventMinute;
    private string editingEventId = "";
    private string status = "";
    private string reminderMessage = "";
    private DateTime displayedMonth = new(DateTime.Today.Year, DateTime.Today.Month, 1);
    private DateTime? selectedCalendarDay;
    private bool busy;
    private bool reminderRefreshInProgress;
    private DateTimeOffset nextReminderRefresh = DateTimeOffset.MinValue;
    private readonly HashSet<string> remindedEventIds = [];
    private List<CalendarEvent> events = [];

    public CalendarWindow(Plugin plugin) : base("FC Event Calendar###FcEventCalendar")
    {
        this.plugin = plugin;
        SetStartPicker(DateTimeOffset.Now.AddHours(1));
        Size = new Vector2(780, 680);
        SizeCondition = ImGuiCond.FirstUseEver;
    }

    public override void Draw()
    {
        if (string.IsNullOrWhiteSpace(plugin.Configuration.DeviceToken)) DrawEnrollment();
        else DrawEvents();
        if (!string.IsNullOrWhiteSpace(reminderMessage))
        {
            ImGui.Separator();
            ImGui.TextColored(new Vector4(1f, 0.8f, 0.2f, 1f), reminderMessage);
            ImGui.SameLine();
            if (ImGui.SmallButton("Dismiss reminder")) reminderMessage = "";
        }
        if (!string.IsNullOrWhiteSpace(status)) ImGui.TextWrapped(status);
    }

    public void UpdateReminders(IFramework framework)
    {
        if (string.IsNullOrWhiteSpace(plugin.Configuration.DeviceToken)) return;

        var now = DateTimeOffset.Now;
        if (!reminderRefreshInProgress && now >= nextReminderRefresh)
        {
            nextReminderRefresh = now.AddMinutes(2);
            reminderRefreshInProgress = true;
            _ = RefreshEventsForRemindersAsync();
        }

        if (!plugin.Configuration.RemindersEnabled) return;
        var reminderWindow = TimeSpan.FromMinutes(Math.Clamp(plugin.Configuration.ReminderMinutesBefore, 1, 1440));
        foreach (var item in events)
        {
            var remaining = item.StartsAt.ToLocalTime() - now;
            if (remaining > TimeSpan.Zero && remaining <= reminderWindow && remindedEventIds.Add(item.Id))
                ShowReminder(item, remaining);
        }
    }

    private void DrawEnrollment()
    {
        ImGui.TextWrapped("Connect once with your FC access code. The code itself is never stored.");
        var serverUrl = plugin.Configuration.ServerUrl;
        if (ImGui.InputText("Server Address", ref serverUrl, 300))
        {
            plugin.Configuration.ServerUrl = serverUrl;
            plugin.Configuration.Save();
        }
        ImGui.InputText("FC Access Code", ref accessCode, 200, ImGuiInputTextFlags.Password);
        if (!Plugin.PlayerState.IsLoaded) ImGui.TextDisabled("Please log in with a character to continue.");
        else if (ImGui.Button("Connect to FC") && !busy) Start(EnrollAsync);
    }

    private void DrawEvents()
    {
        var character = Plugin.PlayerState.CharacterName;
        var world = Plugin.PlayerState.HomeWorld.Value.Name.ToString();
        ImGui.Text($"Logged in as {character} ({world})");
        ImGui.SameLine();
        if (ImGui.Button("Refresh") && !busy) Start(LoadAsync);
        ImGui.SameLine();
        var remindersEnabled = plugin.Configuration.RemindersEnabled;
        if (ImGui.Checkbox("Enable reminders", ref remindersEnabled))
        {
            plugin.Configuration.RemindersEnabled = remindersEnabled;
            plugin.Configuration.Save();
        }
        ImGui.SameLine();
        var reminderMinutes = plugin.Configuration.ReminderMinutesBefore;
        if (ImGui.InputInt("Minutes before", ref reminderMinutes))
        {
            plugin.Configuration.ReminderMinutesBefore = Math.Clamp(reminderMinutes, 1, 1440);
            plugin.Configuration.Save();
        }
        ImGui.SameLine();
        var playSound = plugin.Configuration.PlayReminderSound;
        if (ImGui.Checkbox("Play sound", ref playSound))
        {
            plugin.Configuration.PlayReminderSound = playSound;
            plugin.Configuration.Save();
        }
        ImGui.SameLine();
        if (ImGui.SmallButton("Test reminder")) ShowReminder(null, TimeSpan.Zero);
        ImGui.Separator();
        DrawCalendar();
        ImGui.Separator();
        ImGui.Text(string.IsNullOrEmpty(editingEventId) ? "New Event" : "Edit Event");
        ImGui.InputText("Title", ref title, 120);
        DrawStartPicker();
        ImGui.InputTextMultiline("Description", ref description, 2000, new Vector2(-1, 80));
        if (ImGui.Button(string.IsNullOrEmpty(editingEventId) ? "Create Event" : "Save Changes") && !busy) Start(SaveAsync);
        if (!string.IsNullOrEmpty(editingEventId))
        {
            ImGui.SameLine();
            if (ImGui.Button("Cancel Edit")) { editingEventId = ""; title = ""; description = ""; SetStartPicker(DateTimeOffset.Now.AddHours(1)); }
        }
        ImGui.Separator();
        var visibleEvents = selectedCalendarDay is null
            ? events
            : events.FindAll(item => item.StartsAt.ToLocalTime().Date == selectedCalendarDay.Value.Date);
        if (selectedCalendarDay is not null)
        {
            ImGui.Text($"Events on {selectedCalendarDay.Value:ddd, dd MMM yyyy}");
            ImGui.SameLine();
            if (ImGui.SmallButton("Show all events")) selectedCalendarDay = null;
        }
        foreach (var item in visibleEvents)
        {
            ImGui.Text($"{item.StartsAt.ToLocalTime():ddd, dd.MM. HH:mm}  {item.Title}");
            if (!string.IsNullOrWhiteSpace(item.Description)) ImGui.TextWrapped(item.Description);
            ImGui.TextDisabled($"Attendees: {string.Join(", ", item.Registrations.ConvertAll(x => x.CharacterName + " (" + x.WorldName + ")"))}");
            var joined = item.Registrations.Exists(x => x.CharacterName == character && x.WorldName == world);
            if (ImGui.SmallButton((joined ? "Unregister" : "Register") + "##" + item.Id) && !busy)
                Start(() => joined ? UnregisterAsync(item.Id) : RegisterAsync(item.Id, character, world));
            if (item.CreatedByMemberId == plugin.Configuration.MemberId)
            {
                ImGui.SameLine();
                if (ImGui.SmallButton("Edit##" + item.Id))
                {
                    editingEventId = item.Id;
                    title = item.Title;
                    description = item.Description;
                    SetStartPicker(item.StartsAt);
                }
                ImGui.SameLine();
                if (ImGui.SmallButton("Delete##" + item.Id) && !busy) Start(() => DeleteAsync(item.Id));
            }
            ImGui.Separator();
        }
    }

    private void DrawCalendar()
    {
        ImGui.Text("Calendar");
        if (ImGui.SmallButton("< Previous month")) displayedMonth = displayedMonth.AddMonths(-1);
        ImGui.SameLine();
        if (ImGui.SmallButton("Today")) displayedMonth = new DateTime(DateTime.Today.Year, DateTime.Today.Month, 1);
        ImGui.SameLine();
        if (ImGui.SmallButton("Next month >")) displayedMonth = displayedMonth.AddMonths(1);
        ImGui.SameLine();
        ImGui.Text(displayedMonth.ToString("MMMM yyyy", CultureInfo.InvariantCulture));

        const ImGuiTableFlags flags = ImGuiTableFlags.Borders | ImGuiTableFlags.SizingStretchSame;
        if (!ImGui.BeginTable("CalendarGrid", 7, flags)) return;
        ImGui.TableSetupColumn("Mon");
        ImGui.TableSetupColumn("Tue");
        ImGui.TableSetupColumn("Wed");
        ImGui.TableSetupColumn("Thu");
        ImGui.TableSetupColumn("Fri");
        ImGui.TableSetupColumn("Sat");
        ImGui.TableSetupColumn("Sun");
        ImGui.TableHeadersRow();

        var firstDay = (int)displayedMonth.DayOfWeek;
        var firstColumn = (firstDay + 6) % 7; // Monday is the first column.
        var daysInMonth = DateTime.DaysInMonth(displayedMonth.Year, displayedMonth.Month);
        var day = 1;
        for (var row = 0; row < 6 && day <= daysInMonth; row++)
        {
            ImGui.TableNextRow();
            for (var column = 0; column < 7; column++)
            {
                ImGui.TableSetColumnIndex(column);
                if (row == 0 && column < firstColumn) continue;
                if (day > daysInMonth) continue;

                var date = new DateTime(displayedMonth.Year, displayedMonth.Month, day);
                var dayEvents = events.FindAll(item => item.StartsAt.ToLocalTime().Date == date.Date);
                var label = selectedCalendarDay?.Date == date.Date ? $"[{day}]" : day.ToString();
                if (ImGui.SmallButton(label + "##calendar-" + date.ToString("yyyyMMdd"))) selectedCalendarDay = date;
                if (dayEvents.Count > 0)
                {
                    ImGui.TextColored(new Vector4(0.45f, 0.8f, 1f, 1f), $"{dayEvents.Count} event(s)");
                    foreach (var item in dayEvents.GetRange(0, Math.Min(2, dayEvents.Count)))
                        ImGui.TextWrapped(item.StartsAt.ToLocalTime().ToString("HH:mm") + " " + item.Title);
                    if (dayEvents.Count > 2) ImGui.TextDisabled("More...");
                }
                day++;
            }
        }
        ImGui.EndTable();
    }

    private void DrawStartPicker()
    {
        eventDay = Math.Clamp(eventDay, 1, DateTime.DaysInMonth(eventYear, eventMonth));
        ImGui.Text("Date:");
        ImGui.SameLine();
        ImGui.SetNextItemWidth(55);
        if (ImGui.BeginCombo("##event-day", eventDay.ToString("00")))
        {
            for (var day = 1; day <= DateTime.DaysInMonth(eventYear, eventMonth); day++)
                if (ImGui.Selectable(day.ToString("00"), day == eventDay)) eventDay = day;
            ImGui.EndCombo();
        }
        ImGui.SameLine();
        ImGui.SetNextItemWidth(110);
        if (ImGui.BeginCombo("##event-month", CultureInfo.InvariantCulture.DateTimeFormat.GetMonthName(eventMonth)))
        {
            for (var month = 1; month <= 12; month++)
                if (ImGui.Selectable(CultureInfo.InvariantCulture.DateTimeFormat.GetMonthName(month), month == eventMonth)) eventMonth = month;
            ImGui.EndCombo();
        }
        ImGui.SameLine();
        ImGui.SetNextItemWidth(75);
        if (ImGui.BeginCombo("##event-year", eventYear.ToString()))
        {
            for (var year = DateTime.Today.Year - 1; year <= DateTime.Today.Year + 10; year++)
                if (ImGui.Selectable(year.ToString(), year == eventYear)) eventYear = year;
            ImGui.EndCombo();
        }
        ImGui.SameLine();
        ImGui.Text("Time:");
        ImGui.SameLine();
        ImGui.SetNextItemWidth(55);
        if (ImGui.BeginCombo("##event-hour", eventHour.ToString("00")))
        {
            for (var hour = 0; hour < 24; hour++)
                if (ImGui.Selectable(hour.ToString("00"), hour == eventHour)) eventHour = hour;
            ImGui.EndCombo();
        }
        ImGui.SameLine();
        ImGui.Text(":");
        ImGui.SameLine();
        ImGui.SetNextItemWidth(55);
        if (ImGui.BeginCombo("##event-minute", eventMinute.ToString("00")))
        {
            for (var minute = 0; minute < 60; minute++)
                if (ImGui.Selectable(minute.ToString("00"), minute == eventMinute)) eventMinute = minute;
            ImGui.EndCombo();
        }
    }

    private void SetStartPicker(DateTimeOffset dateTime)
    {
        var local = dateTime.ToLocalTime();
        eventDay = local.Day;
        eventMonth = local.Month;
        eventYear = local.Year;
        eventHour = local.Hour;
        eventMinute = local.Minute;
    }

    private void Start(Func<Task> action) { busy = true; _ = RunAsync(action); }
    private async Task RunAsync(Func<Task> action) { try { await action(); } catch (Exception ex) { status = ex.Message; } finally { busy = false; } }

    private async Task EnrollAsync()
    {
        if (string.IsNullOrWhiteSpace(accessCode)) throw new InvalidOperationException("Please enter the FC access code.");
        var response = await SendAsync(HttpMethod.Post, "/v1/enroll", new { accessCode, characterName = Plugin.PlayerState.CharacterName, worldName = Plugin.PlayerState.HomeWorld.Value.Name.ToString() }, false);
        var payload = await response.Content.ReadFromJsonAsync<EnrollResponse>(json) ?? throw new InvalidOperationException("Invalid server response.");
        plugin.Configuration.DeviceToken = payload.DeviceToken;
        plugin.Configuration.MemberId = payload.Member.Id;
        plugin.Configuration.Save();
        accessCode = "";
        await LoadAsync();
    }

    private async Task LoadAsync()
    {
        if (string.IsNullOrWhiteSpace(plugin.Configuration.MemberId))
        {
            var meResponse = await SendAsync(HttpMethod.Get, "/v1/me", null, true);
            var me = await meResponse.Content.ReadFromJsonAsync<MeResponse>(json) ?? throw new InvalidOperationException("Invalid server response.");
            plugin.Configuration.MemberId = me.Member.Id;
            plugin.Configuration.Save();
        }
        var response = await SendAsync(HttpMethod.Get, "/v1/events?from=2020-01-01T00%3A00%3A00.000Z&until=2100-01-01T00%3A00%3A00.000Z", null, true);
        events = (await response.Content.ReadFromJsonAsync<EventListResponse>(json))?.Events ?? [];
        remindedEventIds.RemoveWhere(eventId => !events.Exists(item => item.Id == eventId));
        status = $"{events.Count} event(s) loaded.";
    }

    private async Task RefreshEventsForRemindersAsync()
    {
        try { await LoadAsync(); }
        catch (Exception ex) { status = ex.Message; }
        finally { reminderRefreshInProgress = false; }
    }

    private void ShowReminder(CalendarEvent? item, TimeSpan remaining)
    {
        var message = item is null
            ? "Test reminder: FC Event Calendar notifications are working."
            : $"Reminder: {item.Title} starts in {Math.Max(1, (int)Math.Ceiling(remaining.TotalMinutes))} minute(s).";
        reminderMessage = message;
        IsOpen = true;
        if (plugin.Configuration.PlayReminderSound) PlayReminderSound();
    }

    private static void PlayReminderSound()
    {
        try { MessageBeep(0x00000040); }
        catch { /* A notification must still work if Windows sound is unavailable. */ }
    }

    [DllImport("user32.dll")]
    private static extern bool MessageBeep(uint soundType);

    private async Task SaveAsync()
    {
        eventDay = Math.Clamp(eventDay, 1, DateTime.DaysInMonth(eventYear, eventMonth));
        var localStart = new DateTime(eventYear, eventMonth, eventDay, eventHour, eventMinute, 0, DateTimeKind.Local);
        var body = new { title, description, startsAt = new DateTimeOffset(localStart).ToUniversalTime().ToString("O") };
        if (string.IsNullOrEmpty(editingEventId))
            await SendAsync(HttpMethod.Post, "/v1/events", body, true);
        else
            await SendAsync(HttpMethod.Patch, "/v1/events/" + editingEventId, body, true);
        title = ""; description = ""; SetStartPicker(DateTimeOffset.Now.AddHours(1));
        editingEventId = "";
        await LoadAsync();
    }

    private async Task RegisterAsync(string eventId, string character, string world)
    {
        await SendAsync(HttpMethod.Post, "/v1/events/" + eventId + "/registrations", new { characterName = character, worldName = world }, true);
        await LoadAsync();
    }

    private async Task UnregisterAsync(string eventId)
    {
        await SendAsync(HttpMethod.Delete, "/v1/events/" + eventId + "/registrations", null, true);
        await LoadAsync();
    }

    private async Task DeleteAsync(string eventId)
    {
        await SendAsync(HttpMethod.Delete, "/v1/events/" + eventId, null, true);
        if (editingEventId == eventId) editingEventId = "";
        await LoadAsync();
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, bool authenticated)
    {
        if (!Uri.TryCreate(plugin.Configuration.ServerUrl.TrimEnd('/') + path, UriKind.Absolute, out var uri)) throw new InvalidOperationException("Invalid server address.");
        using var request = new HttpRequestMessage(method, uri);
        if (authenticated) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", plugin.Configuration.DeviceToken);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await plugin.Http.SendAsync(request);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException(await response.Content.ReadAsStringAsync());
        return response;
    }

    private sealed class EnrollResponse
    {
        public string DeviceToken { get; set; } = "";
        public MemberResponse Member { get; set; } = new();
    }
    private sealed class MemberResponse { public string Id { get; set; } = ""; }
    private sealed class MeResponse { public MemberResponse Member { get; set; } = new(); }
    private sealed class EventListResponse { public List<CalendarEvent> Events { get; set; } = []; }
}

public sealed class CalendarEvent
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public DateTimeOffset StartsAt { get; set; }
    public string CreatedByMemberId { get; set; } = "";
    public List<Registration> Registrations { get; set; } = [];
}

public sealed class Registration
{
    public string CharacterName { get; set; } = "";
    public string WorldName { get; set; } = "";
}
