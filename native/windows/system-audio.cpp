#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <wrl/client.h>
#include <io.h>
#include <fcntl.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>
#include <string>
#include <vector>
using Microsoft::WRL::ComPtr;
static std::atomic<bool> stopping{false};
static void event(const char* name, const char* code = nullptr) {
    if (code) fprintf(stderr, "{\"event\":\"%s\",\"code\":\"%s\"}\n", name, code);
    else fprintf(stderr, "{\"event\":\"%s\"}\n", name);
    fflush(stderr);
}
static bool output(const int16_t* data, size_t count) {
    return fwrite(data, sizeof(int16_t), count, stdout) == count && fflush(stdout) == 0;
}
static uint64_t clock100ns() {
    LARGE_INTEGER value, rate;
    QueryPerformanceCounter(&value); QueryPerformanceFrequency(&rate);
    return uint64_t((long double)value.QuadPart * 10000000 / rate.QuadPart);
}
static int capture() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> device;
    ComPtr<IAudioClient> audio;
    ComPtr<IAudioCaptureClient> reader;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return 1;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &device))) { event("error", "noDevice"); return 1; }
    LPWSTR initialId = nullptr;
    if (FAILED(device->GetId(&initialId))) return 1;
    const std::wstring expected(initialId); CoTaskMemFree(initialId);
    if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audio))) return 1;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 1; format.nSamplesPerSec = 16000;
    format.wBitsPerSample = 16; format.nBlockAlign = 2; format.nAvgBytesPerSec = 32000;
    const DWORD options = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if (FAILED(audio->Initialize(AUDCLNT_SHAREMODE_SHARED, options, 1000000, 0, &format, nullptr)) ||
        FAILED(audio->GetService(IID_PPV_ARGS(&reader))) || FAILED(audio->Start())) {
        event("error", "captureFailed"); return 1;
    }
    event("ready");
    std::thread([] { char command[16]; _read(_fileno(stdin), command, sizeof(command)); stopping = true; }).detach();
    const uint64_t base = clock100ns();
    uint64_t written = 0, checkedAt = base;
    std::vector<int16_t> silence(1600, 0);
    auto pad = [&](uint64_t until) {
        while (written < until && !stopping) {
            size_t count = size_t((std::min)(until - written, uint64_t(silence.size())));
            if (!output(silence.data(), count)) return false;
            written += count;
        }
        return true;
    };
    const char* failure = nullptr;
    while (!stopping) {
        const uint64_t now = clock100ns();
        if (now - base >= 3600ULL * 10000000) { failure = "limit"; break; }
        if (now - checkedAt >= 5000000) {
            checkedAt = now;
            ComPtr<IMMDevice> current;
            LPWSTR currentId = nullptr;
            bool changed = FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &current)) || FAILED(current->GetId(&currentId));
            if (currentId) { changed = changed || expected != currentId; CoTaskMemFree(currentId); }
            if (changed) { failure = "deviceChanged"; break; }
        }
        UINT32 packets = 0;
        if (FAILED(reader->GetNextPacketSize(&packets))) { failure = "deviceChanged"; break; }
        if (!packets) {
            // Keep silence on the recording timeline, allowing 100 ms for late packets.
            if (now > base + 1000000 && !pad((now - base - 1000000) * 16000 / 10000000)) { failure = "slowConsumer"; break; }
            Sleep(5); continue;
        }
        BYTE* bytes = nullptr; UINT32 frames = 0; DWORD flags = 0;
        UINT64 position = 0, timestamp = 0;
        if (FAILED(reader->GetBuffer(&bytes, &frames, &flags, &position, &timestamp))) { failure = "captureFailed"; break; }
        const uint64_t start = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ? written : timestamp >= base ? (timestamp - base) * 16000 / 10000000 : 0;
        bool good = pad(start);
        const uint64_t skipped = written > start ? (std::min)(written - start, uint64_t(frames)) : 0;
        size_t remaining = size_t(frames - skipped);
        if (good && remaining) {
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) good = pad(written + remaining);
            else { good = output(reinterpret_cast<int16_t*>(bytes) + skipped, remaining); written += good ? remaining : 0; }
        }
        reader->ReleaseBuffer(frames);
        if (!good) { failure = "slowConsumer"; break; }
    }
    audio->Stop();
    if (failure) { event("error", failure); return 1; }
    event("stopped"); return 0;
}
int main(int argc, char** argv) {
    _setmode(_fileno(stdout), _O_BINARY); _setmode(_fileno(stdin), _O_BINARY);
    if (argc != 2) return 64;
    if (!strcmp(argv[1], "--probe")) { event("supported"); return 0; }
    if (!strcmp(argv[1], "--self-test")) {
        event("ready"); std::vector<int16_t> samples(320);
        for (int block = 0; block < 150; block++) {
            for (int i = 0; i < 320; i++) samples[i] = int16_t(sin((block * 320 + i) * 2 * 3.141592653589793 * 440 / 16000) * 4000);
            if (!output(samples.data(), samples.size())) return 1;
            Sleep(20);
        }
        event("stopped"); return 0;
    }
    if (strcmp(argv[1], "--capture")) return 64;
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
    int result = capture(); CoUninitialize(); return result;
}
