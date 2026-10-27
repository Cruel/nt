#pragma once

#include <array>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::cli {

// Web shell source is embedded in the native CLI so installed/relocated
// exports cannot depend on the editor's TypeScript build or source tree.
inline std::string web_shell_escape(std::string_view value)
{
    std::string escaped;
    for (char c : value) {
        switch (c) {
        case '&':
            escaped += "&amp;";
            break;
        case '<':
            escaped += "&lt;";
            break;
        case '>':
            escaped += "&gt;";
            break;
        case '"':
            escaped += "&quot;";
            break;
        case '\'':
            escaped += "&#39;";
            break;
        default:
            escaped += c;
        }
    }
    return escaped;
}

inline std::string web_shell_json(std::string_view value)
{
    // Encode JS string literals without depending on JSON types in this
    // header. In particular, < must not allow an embedded </script> tag.
    constexpr char hex[] = "0123456789abcdef";
    std::string escaped = "\"";
    for (unsigned char c : value) {
        switch (c) {
        case '\\':
            escaped += "\\\\";
            break;
        case '"':
            escaped += "\\\"";
            break;
        case '<':
            escaped += "\\u003c";
            break;
        case '\b':
            escaped += "\\b";
            break;
        case '\f':
            escaped += "\\f";
            break;
        case '\n':
            escaped += "\\n";
            break;
        case '\r':
            escaped += "\\r";
            break;
        case '\t':
            escaped += "\\t";
            break;
        default:
            if (c < 32) {
                escaped += "\\u00";
                escaped += hex[c >> 4];
                escaped += hex[c & 15];
            } else {
                escaped += static_cast<char>(c);
            }
        }
    }
    escaped += '"';
    return escaped;
}

inline std::string web_player_shell(std::string_view title, std::string_view locale,
                                    std::string_view theme, std::string_view background,
                                    std::string_view base_path, std::string_view favicon,
                                    std::string_view script, std::string_view wasm,
                                    std::string_view data, bool offline)
{
    std::string html = R"NTWEB(<!doctype html>
<html lang="__LOCALE__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>__TITLE__</title><link rel="manifest" href="__MANIFEST__">__FAVICON__<meta name="theme-color" content="__THEME__"><style>html,body{width:100%;height:100%;margin:0;background:__BACKGROUND__}body{position:relative;overflow:hidden;font-family:system-ui,sans-serif}#canvas{position:absolute;left:0;top:0;display:block;max-width:none;max-height:none}#launch,#failure{position:fixed;inset:0;display:grid;place-content:center;text-align:center;padding:2rem;background:__BACKGROUND__;color:white;z-index:2}#failure{display:none}#fps-counter{display:none;position:fixed;left:16px;bottom:16px;z-index:3;padding:4px 6px;border-radius:4px;background:rgba(15,23,42,.84);color:#cbd5e1;font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:none}button{font:inherit;padding:.8rem 1.2rem}</style></head><body><canvas id="canvas" tabindex="-1"></canvas><div id="launch"><h1>__TITLE__</h1><button id="start">Start</button></div><div id="failure"><h1>Unable to start</h1><p id="failure-message"></p></div><div id="fps-counter"></div><script>
const fail=m=>{document.getElementById('launch').style.display='none';document.getElementById('failure').style.display='grid';document.getElementById('failure-message').textContent=m};
if(!window.WebAssembly||!document.createElement('canvas').getContext('webgl2')) fail('This browser does not support WebAssembly and WebGL 2.');
const params=new URLSearchParams(window.location.search);const showFps=['1','true','yes'].includes((params.get('showFps')||'').toLowerCase());const fpsCap=Math.max(0,Math.min(1000,Number.parseInt(params.get('fpsCap')||'0',10)||0));const requestedRmluiSnap=(params.get('rmluiSnap')||'all').toLowerCase();const rmluiSnap=['none','geometry','text','all'].includes(requestedRmluiSnap)?requestedRmluiSnap:'all';
globalThis.NovelTeaPreviewBridge={send(){},markEngineReady(){},setFpsCounter(fps,frameTimeMs,cap){const counter=document.getElementById('fps-counter');if(!counter)return;if(!showFps||!Number.isFinite(fps)||fps<=0){counter.style.display='none';counter.textContent='';return}counter.textContent=fps.toFixed(1)+' fps · '+frameTimeMs.toFixed(2)+' ms · '+(cap>0?'engine cap '+cap+', display paced':'display paced');counter.style.display='block'}};
const canvas=document.getElementById('canvas');let runtimeReady=false;let pendingResize=null;let resizeScheduled=false;let appliedResize='';let dprMediaQuery=null;
const currentDevicePixelRatio=()=>{const dpr=Number(window.devicePixelRatio);return Number.isFinite(dpr)&&dpr>0?dpr:1};
// BEGIN web-player-surface-metrics
function resolveWebPlayerSurfaceMetrics(cssWidth,cssHeight,devicePixelRatio){const measuredCssWidth=Number.isFinite(cssWidth)&&cssWidth>0?cssWidth:1;const measuredCssHeight=Number.isFinite(cssHeight)&&cssHeight>0?cssHeight:1;const dpr=Number.isFinite(devicePixelRatio)&&devicePixelRatio>0?devicePixelRatio:1;const logicalWidth=Math.max(1,Math.round(measuredCssWidth));const logicalHeight=Math.max(1,Math.round(measuredCssHeight));const framebufferWidth=Math.max(1,Math.round(measuredCssWidth*dpr));const framebufferHeight=Math.max(1,Math.round(measuredCssHeight*dpr));return{logicalWidth,logicalHeight,framebufferWidth,framebufferHeight,scaleX:framebufferWidth/logicalWidth,scaleY:framebufferHeight/logicalHeight}}
// END web-player-surface-metrics
const measureCanvas=()=>{const rect=document.body.getBoundingClientRect();const resize=resolveWebPlayerSurfaceMetrics(rect.width,rect.height,currentDevicePixelRatio());if(!runtimeReady){if(canvas.width!==resize.framebufferWidth)canvas.width=resize.framebufferWidth;if(canvas.height!==resize.framebufferHeight)canvas.height=resize.framebufferHeight;canvas.style.width=rect.width+'px';canvas.style.height=rect.height+'px'}pendingResize={...resize,cssWidth:rect.width,cssHeight:rect.height};scheduleResize()};
const applyCanvasPresentation=r=>{const capacityWidth=typeof Module._noveltea_player_backbuffer_width==='function'?Module._noveltea_player_backbuffer_width():canvas.width;const capacityHeight=typeof Module._noveltea_player_backbuffer_height==='function'?Module._noveltea_player_backbuffer_height():canvas.height;if(capacityWidth<=0||capacityHeight<=0)return false;canvas.style.width=r.cssWidth*capacityWidth/r.framebufferWidth+'px';canvas.style.height=r.cssHeight*capacityHeight/r.framebufferHeight+'px';return true};
const applyResize=()=>{if(!runtimeReady||!pendingResize||typeof Module._noveltea_player_resize!=='function')return;const r=pendingResize;const key=r.logicalWidth+'x'+r.logicalHeight+':'+r.framebufferWidth+'x'+r.framebufferHeight+':'+r.scaleX+'x'+r.scaleY;if(key===appliedResize){applyCanvasPresentation(r);return}if(Module._noveltea_player_resize(r.logicalWidth,r.logicalHeight,r.framebufferWidth,r.framebufferHeight,r.scaleX,r.scaleY)!==1){scheduleResize();return}appliedResize=key;applyCanvasPresentation(r);requestAnimationFrame(()=>{if(pendingResize)applyCanvasPresentation(pendingResize)})};
const scheduleResize=()=>{if(resizeScheduled)return;resizeScheduled=true;requestAnimationFrame(()=>{resizeScheduled=false;applyResize()})};
const handleDevicePixelRatioChange=()=>{armDevicePixelRatioWatcher();measureCanvas()};
const armDevicePixelRatioWatcher=()=>{if(dprMediaQuery){dprMediaQuery.removeEventListener('change',handleDevicePixelRatioChange);dprMediaQuery=null}if(typeof window.matchMedia!=='function')return;dprMediaQuery=window.matchMedia('(resolution: '+currentDevicePixelRatio()+'dppx)');dprMediaQuery.addEventListener('change',handleDevicePixelRatioChange,{once:true})};
armDevicePixelRatioWatcher();new ResizeObserver(measureCanvas).observe(document.body);window.addEventListener('resize',measureCanvas);window.addEventListener('pageshow',measureCanvas);document.addEventListener('visibilitychange',()=>{if(!document.hidden)measureCanvas()});measureCanvas();
document.getElementById('start').addEventListener('click',()=>{document.getElementById('launch').style.display='none';measureCanvas();const args=['--rmlui-snap',rmluiSnap];if(showFps)args.push('--show-fps');if(fpsCap>0)args.push('--fps-cap',String(fpsCap));window.Module={canvas,arguments:args,locateFile:p=>p==='player.wasm'?__WASM__:p==='player.data'?__DATA__:__BASE__+p,onRuntimeInitialized:()=>{runtimeReady=true;measureCanvas();scheduleResize()},onNovelTeaStartupError:fail};const s=document.createElement('script');s.src=__SCRIPT__;s.onerror=()=>fail('The player could not be downloaded.');document.body.appendChild(s)});
__SW__
</script></body></html>
)NTWEB";
    // Substitute in one pass. A project title/base path may itself contain a
    // placeholder-like sequence and must never be interpreted as shell code.
    const std::array<std::pair<std::string_view, std::string>, 11> replacements{{
        {"__TITLE__", web_shell_escape(title)},
        {"__LOCALE__", web_shell_escape(locale)},
        {"__THEME__", web_shell_escape(theme)},
        {"__BACKGROUND__", web_shell_escape(background)},
        {"__MANIFEST__", web_shell_escape(std::string(base_path) + "manifest.webmanifest")},
        {"__FAVICON__", favicon.empty()
                            ? ""
                            : "<link rel=\"icon\" href=\"" +
                                  web_shell_escape(std::string(base_path) + std::string(favicon)) +
                                  "\">"},
        {"__WASM__", web_shell_json(std::string(base_path) + std::string(wasm))},
        {"__DATA__", web_shell_json(std::string(base_path) + std::string(data))},
        {"__SCRIPT__", web_shell_json(std::string(base_path) + std::string(script))},
        {"__BASE__", web_shell_json(base_path)},
        {"__SW__", offline ? "if('serviceWorker' in navigator) navigator.serviceWorker.register(" +
                                 web_shell_json(std::string(base_path) + "service-worker.js") +
                                 ", {scope:" + web_shell_json(base_path) +
                                 "}).catch(error=>console.warn('[service-worker]',error));"
                           : ""},
    }};
    std::string output;
    output.reserve(html.size() + 256);
    for (std::size_t at = 0; at < html.size();) {
        bool replaced = false;
        for (const auto& [token, value] : replacements) {
            if (html.compare(at, token.size(), token) == 0) {
                output += value;
                at += token.size();
                replaced = true;
                break;
            }
        }
        if (!replaced)
            output += html[at++];
    }
    return output;
}

} // namespace noveltea::cli
