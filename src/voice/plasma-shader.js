// Adapted from Pipecat Voice UI Kit Plasma.tsx, BSD-2-Clause, Daily 2024–2025.
// Source commit 56e371bb48f1df21a684dc2725173b218228f3e2. License: electron/voice/LICENSE.plasma.
// Changes: transparent output, a soft circular edge to avoid clipped glow, and
// a direct WebGL quad, no Pipecat or Three runtime. Noise/core/rings are preserved.
export const fragmentShader = `precision highp float;

    uniform vec2 iResolution;
    uniform float iTime;
    uniform float intensity;
    uniform float radius;
    uniform int blendMode;
    uniform float effectScale;
    uniform vec2 effectCenter;
    uniform vec3 color1;
    uniform vec3 color2;
    uniform vec3 color3;
    uniform bool useCustomColors;
    uniform float colorCycleSpeed;
    uniform float ringCount;
    uniform float ringVisibility;
    uniform float ringDistance;
    uniform float ringSpread;
    uniform float ringBounce;
    uniform float ringThickness;
    uniform float ringVariance;
    uniform float ringSharpness;
    uniform float ringAmplitude;
    uniform float ringSpeed;
    uniform float ringSegments;
    uniform float ringColorInheritance;
    uniform vec3 backgroundColor;
    uniform float plasmaSpeed;
    uniform float rayLength;
    uniform float glowFalloff;
    uniform float glowThreshold;
    varying vec2 vUv;

    #define TAU 6.2831852
    #define MOD3 vec3(.1031,.11369,.13787)

    vec3 blendColors(vec3 bg, vec3 fg, float amt, int mode) {
        if (mode == 0) return mix(bg, fg, amt);
        if (mode == 1) return clamp(bg + fg * amt, 0.0, 1.0);
        if (mode == 2) return 1.0 - (1.0 - bg) * (1.0 - fg * amt);
        if (mode == 3) {
            vec3 base = bg;
            vec3 blend = fg * amt;
            return vec3(
                (base.r < 0.5) ? (2.0 * base.r * blend.r) : (1.0 - 2.0 * (1.0 - base.r) * (1.0 - blend.r)),
                (base.g < 0.5) ? (2.0 * base.g * blend.g) : (1.0 - 2.0 * (1.0 - base.g) * (1.0 - blend.g)),
                (base.b < 0.5) ? (2.0 * base.b * blend.b) : (1.0 - 2.0 * (1.0 - base.b) * (1.0 - blend.b))
            );
        }
        if (mode == 4) {
            vec3 base = bg;
            vec3 blend = fg * amt;
            return vec3(
                (blend.r < 0.5) ? (base.r - (1.0 - 2.0 * blend.r) * base.r * (1.0 - base.r)) : (base.r + (2.0 * blend.r - 1.0) * (sqrt(base.r) - base.r)),
                (blend.g < 0.5) ? (base.g - (1.0 - 2.0 * blend.g) * base.g * (1.0 - base.g)) : (base.g + (2.0 * blend.g - 1.0) * (sqrt(base.g) - base.g)),
                (blend.b < 0.5) ? (base.b - (1.0 - 2.0 * blend.b) * base.b * (1.0 - base.b)) : (base.b + (2.0 * blend.b - 1.0) * (sqrt(base.b) - base.b))
            );
        }
        if (mode == 5) return bg * (1.0 - amt) + fg * amt;
        return mix(bg, fg, amt);
    }

    vec3 hash33(vec3 p3) {
        p3 = fract(p3 * MOD3);
        p3 += dot(p3, p3.yxz+19.19);
        return -1.0 + 2.0 * fract(vec3((p3.x + p3.y)*p3.z, (p3.x+p3.z)*p3.y, (p3.y+p3.z)*p3.x));
    }

    float simplex_noise(vec3 p) {
        const float K1 = 0.333333333;
        const float K2 = 0.166666667;

        vec3 i = floor(p + (p.x + p.y + p.z) * K1);
        vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);

        vec3 e = step(vec3(0.0), d0 - d0.yzx);
        vec3 i1 = e * (1.0 - e.zxy);
        vec3 i2 = 1.0 - e.zxy * (1.0 - e);

        vec3 d1 = d0 - (i1 - K2);
        vec3 d2 = d0 - (i2 - 2.0 * K2);
        vec3 d3 = d0 - (1.0 - 3.0 * K2);

        vec4 h = max(0.6 - vec4(dot(d0, d0), dot(d1, d1), dot(d2, d2), dot(d3, d3)), 0.0);
        vec4 n = h * h * h * h * vec4(dot(d0, hash33(i)), dot(d1, hash33(i + i1)), dot(d2, hash33(i + i2)), dot(d3, hash33(i + 1.0)));

        return dot(vec4(31.316), n);
    }

    vec3 getColor(vec2 uv, float t, float intensity) {
        float radius = length(uv);
        float angular1 = dot(uv, vec2(1.0, 0.0)) / (radius + 0.001);
        float angular2 = dot(uv, vec2(0.0, 1.0)) / (radius + 0.001);

        float phase1 = t * colorCycleSpeed + radius * 3.0 + intensity * 2.0;
        float phase2 = t * colorCycleSpeed * 0.7 + angular1 * 2.0 + intensity * 1.5;
        float phase3 = t * colorCycleSpeed * 1.3 + (radius + angular2) * 1.5;

        if (useCustomColors) {
            float band1 = sin(phase1) * 0.5 + 0.5;
            float band2 = sin(phase2 + 2.094) * 0.5 + 0.5;
            float band3 = sin(phase3 + 4.189) * 0.5 + 0.5;

            band1 = pow(band1, 1.0 - intensity * 0.5);
            band2 = pow(band2, 1.0 - intensity * 0.3);
            band3 = pow(band3, 1.0 - intensity * 0.4);

            float sum = band1 + band2 + band3;
            return (color1 * band1 + color2 * band2 + color3 * band3) / sum;
        } else {
            vec3 rainbow = 0.5 + 0.5 * cos(phase1 + uv.xyx * 3.0 + vec3(0.0, 2.0, 4.0));
            vec3 rainbow2 = 0.5 + 0.5 * cos(phase2 + uv.yxy * 2.0 + vec3(1.0, 3.0, 5.0));
            return mix(rainbow, rainbow2, intensity);
        }
    }

    void main() {
        vec2 uv = (vUv * iResolution - iResolution.xy * 0.5) / iResolution.y;
        uv = (uv - effectCenter) / effectScale;

        float a = sin(atan(uv.y, uv.x));
        float am = abs(a - 0.5) * 0.25;
        float l = length(uv);

        float m1 = clamp(0.1 / smoothstep(0.0, radius, l), 0.0, 1.0);
        float m2 = clamp(0.1 / smoothstep(0.42, 0.0, l), 0.0, 1.0);

        float glowAttenuation = exp(-l * glowFalloff);
        m1 *= glowAttenuation;

        float s1 = simplex_noise(vec3(uv * 2.0, 1.0 + iTime * 0.525 * plasmaSpeed)) * max(1.0 - l * rayLength, 0.0) + 0.9;
        float s2 = simplex_noise(vec3(uv, 15.0 + iTime * 0.525 * plasmaSpeed)) * max(l, 0.025) + 1.25;
        float s3 = simplex_noise(vec3(vec2(am, am * 100.0 + iTime * 3.0 * plasmaSpeed) * 0.15, 30.0 + iTime * 0.525 * plasmaSpeed)) * max(l, 0.25) + 1.5;
        s3 *= smoothstep(0.0, 0.3345, l);

        float sh = smoothstep(0.15, 0.35, l);
        float m = m1 * m1 * m2 * s1 * s2 * s3 * (1.0 - l) * sh * intensity;

        m = max(0.0, m - glowThreshold) / (1.0 - glowThreshold);

        float normalizedIntensity = clamp(m / intensity, 0.0, 1.0);
        vec3 colorVal = getColor(uv, iTime, normalizedIntensity);
        vec3 col = blendColors(backgroundColor, colorVal, m, blendMode);

        float angle = atan(uv.y, uv.x);
        float wave = iTime * ringSpeed;
        float pixelSize = 2.0 / iResolution.y;
        float thicknessFactor = ringThickness * ringThickness * 0.0001;
        float baseThickness = pixelSize * (1.0 + thicknessFactor * 99.0);
        float ringStart = 0.3;

        vec3 ringAccum = vec3(0.0);
        int numRings = int(ringCount);

        for (int i = 0; i < 5; i++) {
            if (i >= numRings) break;

            float ringIndex = float(i);
            float phaseOffset1 = ringIndex * 1.7 + ringVariance * sin(ringIndex * 3.14);
            float phaseOffset2 = ringIndex * 2.3 + ringVariance * cos(ringIndex * 2.71);
            float speedVariance = 1.0 + ringVariance * sin(ringIndex * 4.5) * 0.5;

            float normalizedAngle = angle * 0.159154943 + 0.5;
            float segmentsFloor = floor(ringSegments + 0.5);

            float wavePhase1 = sin(normalizedAngle * segmentsFloor * TAU + wave * speedVariance + phaseOffset1);
            float wavePhase2 = sin(normalizedAngle * floor(ringSegments * 1.5 + 0.5) * TAU - wave * speedVariance * 0.7 + phaseOffset2);
            float wavePhase3 = sin(normalizedAngle * floor(ringSegments * 0.5 + 0.5) * TAU + wave * speedVariance * 1.3 + ringIndex);

            float fractSegments = fract(ringSegments);
            if (fractSegments > 0.0) {
                float nextWavePhase1 = sin(normalizedAngle * floor(ringSegments + 1.5) * TAU + wave * speedVariance + phaseOffset1);
                wavePhase1 = mix(wavePhase1, nextWavePhase1, smoothstep(0.0, 1.0, fractSegments));
            }

            float combinedWave = mix(wavePhase1, wavePhase1 * 0.4 + wavePhase2 * 0.4 + wavePhase3 * 0.2, ringVariance);

            float baseRadius = ringStart + ringDistance + ringSpread * ringIndex * 0.2;
            if (ringBounce > 0.0) {
                baseRadius *= 1.0 + sin(iTime * 2.0 + ringIndex * 0.5) * ringBounce;
            }

            float ringRadius = baseRadius + ringAmplitude * combinedWave;
            float thicknessModulation = 1.0 + ringVariance * combinedWave * 0.3;
            float currentThickness = baseThickness * thicknessModulation;

            float ringDist = abs(l - ringRadius);
            float softEdge = smoothstep(currentThickness, currentThickness * 0.2, ringDist);
            float hardEdge = 1.0 - step(currentThickness * 0.5, ringDist);
            float ringMask = mix(softEdge, hardEdge, ringSharpness);

            float falloff = exp(-ringIndex * 0.3);
            float ringStrength = ringMask * ringVisibility * falloff;

            vec3 ringColor = vec3(1.0);
            if (useCustomColors) {
                float colorPhase = iTime * 0.3 + ringIndex * 0.7;
                vec3 originalRingColor = getColor(uv * 0.5, colorPhase, ringStrength);

                if (ringColorInheritance > 0.0) {
                    vec2 samplePos = normalize(uv) * ringRadius;
                    vec3 plasmaColor = getColor(samplePos, iTime, ringStrength);
                    ringColor = mix(originalRingColor, plasmaColor, ringColorInheritance);
                } else {
                    ringColor = originalRingColor;
                }
            }

            if (ringVariance > 0.0) {
                float noiseScale = 10.0 + ringIndex * 2.0;
                float ringNoise = simplex_noise(vec3(uv * noiseScale, iTime * 0.5 + ringIndex)) * 0.5 + 0.5;
                ringStrength *= mix(1.0, ringNoise, ringVariance * 0.5);
            }

            ringAccum += ringColor * ringStrength * 0.6;
        }

        col = clamp(col + ringAccum, 0.0, 1.5);
        float alpha = clamp(max(max(col.r, col.g), col.b), 0.0, 1.0);
        float edgeFade = 1.0 - smoothstep(0.39, 0.5, length(vUv - 0.5));
        gl_FragColor = vec4(col / max(alpha, 0.001), alpha * edgeFade);
    }
  `;
