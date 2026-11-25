#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <windowsx.h>
#include <algorithm>
#include <array>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace {
constexpr UINT captionMessage = WM_APP + 1;
constexpr wchar_t className[] = L"VoiceNotesDesktopCaptions";
enum class Edge { none, left, right, top, bottom };
std::mutex captionMutex;
std::wstring caption;
bool collapsed = false;
Edge dock = Edge::none;

RECT workArea(HWND window) {
    MONITORINFO monitor{};
    monitor.cbSize = sizeof(monitor);
    GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor);
    return monitor.rcWork;
}

int scaled(HWND window, int points) {
    return MulDiv(points, static_cast<int>(GetDpiForWindow(window)), 96);
}

Edge nearestEdge(const RECT& frame, const RECT& area, int threshold) {
    const std::array<std::pair<Edge, int>, 4> distances{{
        { Edge::left, std::abs(frame.left - area.left) },
        { Edge::right, std::abs(frame.right - area.right) },
        { Edge::top, std::abs(frame.top - area.top) },
        { Edge::bottom, std::abs(frame.bottom - area.bottom) },
    }};
    const auto best = std::min_element(distances.begin(), distances.end(),
        [](const auto& a, const auto& b) { return a.second < b.second; });
    return threshold < 0 || best->second <= threshold ? best->first : Edge::none;
}

void place(HWND window, const RECT& area, long centerX, long centerY, int width, int height) {
    width = std::min(width, int(area.right - area.left));
    height = std::min(height, int(area.bottom - area.top));
    auto x = std::clamp(centerX - width / 2, area.left, area.right - width);
    auto y = std::clamp(centerY - height / 2, area.top, area.bottom - height);
    if (dock == Edge::left) x = area.left;
    if (dock == Edge::right) x = area.right - width;
    if (dock == Edge::top) y = area.top;
    if (dock == Edge::bottom) y = area.bottom - height;
    SetWindowPos(window, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE);
}

HFONT captionFont(HWND window) {
    return CreateFontW(-scaled(window, 17), 0, 0, 0, FW_MEDIUM,
        FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

std::wstring currentCaption() {
    const std::scoped_lock lock(captionMutex);
    return caption;
}

SIZE captionSize(HWND window, const RECT& area) {
    if (collapsed) return { scaled(window, 48), scaled(window, 38) };
    const auto line = currentCaption();
    const HDC dc = GetDC(window);
    const HFONT font = captionFont(window);
    const auto previous = SelectObject(dc, font);
    SIZE extent{};
    GetTextExtentPoint32W(dc, line.c_str(), static_cast<int>(line.size()), &extent);
    const int width = std::min({ int(area.right - area.left), scaled(window, 660),
        std::max(scaled(window, 126), int(extent.cx) + scaled(window, 68)) });
    RECT bounds{0, 0, std::max(1, width - scaled(window, 60)), 0};
    DrawTextW(dc, line.c_str(), -1, &bounds, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
    SelectObject(dc, previous);
    DeleteObject(font);
    ReleaseDC(window, dc);
    const int height = std::min(int((area.bottom - area.top) * 0.65),
        std::max(scaled(window, 44), int(bounds.bottom) + scaled(window, 20)));
    return { width, height };
}

void draw(HWND window) {
    PAINTSTRUCT paint{};
    const HDC dc = BeginPaint(window, &paint);
    RECT bounds{};
    GetClientRect(window, &bounds);
    const HBRUSH background = CreateSolidBrush(RGB(26, 26, 26));
    FillRect(dc, &bounds, background);
    DeleteObject(background);
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, RGB(255, 255, 255));
    const HFONT font = captionFont(window);
    const auto previous = SelectObject(dc, font);
    RECT toggle = bounds;
    toggle.left = std::max(0L, bounds.right - scaled(window, 40));
    DrawTextW(dc, collapsed ? L"+" : L"\u2212", -1, &toggle, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    if (!collapsed) {
        const auto line = currentCaption();
        RECT content{scaled(window, 12), 0, bounds.right - scaled(window, 48), bounds.bottom};
        constexpr UINT flags = DT_CENTER | DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL;
        RECT measured = content;
        DrawTextW(dc, line.c_str(), -1, &measured, flags | DT_CALCRECT);
        content.top = std::max(0L, (bounds.bottom - measured.bottom) / 2);
        DrawTextW(dc, line.c_str(), -1, &content, flags);
    }
    SelectObject(dc, previous);
    DeleteObject(font);
    EndPaint(window, &paint);
}

LRESULT CALLBACK onMessage(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    switch (message) {
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_NCHITTEST: {
        POINT pos{GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
        ScreenToClient(window, &pos);
        RECT bounds{};
        GetClientRect(window, &bounds);
        return pos.x >= bounds.right - scaled(window, 32) ? HTCLIENT : HTCAPTION;
    }
    case WM_LBUTTONUP:
    case WM_EXITSIZEMOVE:
    case WM_DPICHANGED: {
        RECT frame{};
        GetWindowRect(window, &frame);
        const auto area = workArea(window);
        if (message == WM_LBUTTONUP) collapsed = !collapsed;
        if (message == WM_EXITSIZEMOVE || (message == WM_LBUTTONUP && dock == Edge::none)) {
            dock = nearestEdge(frame, area, collapsed ? -1 : scaled(window, 30));
        }
        const SIZE size = captionSize(window, area);
        place(window, area, (frame.left + frame.right) / 2, (frame.top + frame.bottom) / 2, size.cx, size.cy);
        InvalidateRect(window, nullptr, FALSE);
        return 0;
    }
    case captionMessage: {
        if (!collapsed) {
            RECT frame{};
            GetWindowRect(window, &frame);
            const auto area = workArea(window);
            const SIZE size = captionSize(window, area);
            if (size.cx != frame.right - frame.left || size.cy != frame.bottom - frame.top) {
                place(window, area, (frame.left + frame.right) / 2, frame.bottom - size.cy / 2, size.cx, size.cy);
            }
        }
        InvalidateRect(window, nullptr, FALSE);
        return 0;
    }
    case WM_PAINT:
        draw(window);
        return 0;
    case WM_CLOSE:
        DestroyWindow(window);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wp, lp);
    }
}

std::wstring decoded(const std::string& bytes) {
    if (bytes.empty() || bytes.size() > 8192) return {};
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
    if (length == 0) return {};
    std::wstring line(length, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), line.data(), length);
    return line;
}
}

int main() {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW descriptor{};
    descriptor.lpfnWndProc = onMessage;
    descriptor.hInstance = instance;
    descriptor.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
    descriptor.lpszClassName = className;
    if (!RegisterClassW(&descriptor)) return 1;
    const HWND window = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
        className, L"Voice Notes captions", WS_POPUP, 0, 0, 180, 44, nullptr, nullptr, instance, nullptr);
    if (!window) return 1;
    const auto area = workArea(window);
    place(window, area, (area.left + area.right) / 2, area.bottom - scaled(window, 40), scaled(window, 180), scaled(window, 44));
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    std::cout << "ready\n" << std::flush;
    std::thread([window] {
        std::string bytes;
        while (std::getline(std::cin, bytes)) {
            {
                const std::scoped_lock lock(captionMutex);
                caption = decoded(bytes);
            }
            PostMessageW(window, captionMessage, 0, 0);
        }
        PostMessageW(window, WM_CLOSE, 0, 0);
    }).detach();
    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
