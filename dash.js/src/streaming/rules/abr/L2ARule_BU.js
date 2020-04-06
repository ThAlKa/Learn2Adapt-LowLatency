
/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2016, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

// For a description of the L2A adaptive bitrate (ABR) algorithm, see http://arxiv.org/abs/1601.06748

import MetricsConstants from '../../constants/MetricsConstants';
import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import { HTTPRequest } from '../../vo/metrics/HTTPRequest';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import Debug from '../../../core/Debug';

// L2A_STATE_ONE_BITRATE   : If there is only one bitrate (or initialization failed), always return NO_CHANGE.
// L2A_STATE_STARTUP       : Set placeholder buffer such that we download fragments at most recently measured throughput.
// L2A_STATE_STEADY        : Buffer primed, we switch to steady operation.
// TODO: add L2A_STATE_SEEK and tune L2A behavior on seeking
const L2A_STATE_ONE_BITRATE    = 0;
const L2A_STATE_STARTUP        = 1;
const L2A_STATE_STEADY         = 2;

const MINIMUM_BUFFER_S = 10; // L2A should never add artificial delays if buffer is less than MINIMUM_BUFFER_S.
const MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2;
// E.g. if there are 5 bitrates, L2A switches to top bitrate at buffer = 10 + 5 * 2 = 20s.
// If Schedule Controller does not allow buffer to reach that level, it can be achieved through the placeholder buffer level.

const PLACEHOLDER_BUFFER_DECAY = 0.99; // Make sure placeholder buffer does not stick around too long.


let w = [];
let prev_w = [];
let prev_w2 = [];
let sum_w = [];
let Q1=0;
let Q2=0;
let B_target=0.5;
let prevqualityL2A=0;
let counter=0;
let segment_request_start_s=0;
let segment_download_finish_s=0;


function L2ARule(config) {

    config = config || {};
    const context = this.context;

    const dashMetrics = config.dashMetrics;
    const mediaPlayerModel = config.mediaPlayerModel;
    const eventBus = EventBus(context).getInstance();

    let instance,
        logger,
        L2AStateDict;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        resetInitialSettings();

        eventBus.on(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.on(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
        eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
        eventBus.on(Events.METRIC_ADDED, onMetricAdded, instance);
        eventBus.on(Events.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        eventBus.on(Events.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);
    }

    function utilitiesFromBitrates(bitrates) {
        return bitrates.map(b => Math.log(b)); 
        // no need to worry about offset, utilities will be offset (uniformly) anyway later
    }

    // NOTE: in live streaming, the real buffer level can drop below minimumBufferS, but L2A should not stick to lowest bitrate by using a placeholder buffer level
    function calculateL2AParameters(stableBufferTime, bitrates, utilities) {
        const highestUtilityIndex = utilities.reduce((highestIndex, u, uIndex) => (u > utilities[highestIndex] ? uIndex : highestIndex), 0);

        if (highestUtilityIndex === 0) {
            // if highestUtilityIndex === 0, then always use lowest bitrate
            return null;
        }

        const bufferTime = Math.max(stableBufferTime, MINIMUM_BUFFER_S + MINIMUM_BUFFER_PER_BITRATE_LEVEL_S * bitrates.length);

        // TODO: Investigate if following can be better if utilities are not the default Math.log utilities.
        // If using Math.log utilities, we can choose Vp and gp to always prefer bitrates[0] at minimumBufferS and bitrates[max] at bufferTarget.
        // (Vp * (utility + gp) - bufferLevel) / bitrate has the maxima described when:
        // Vp * (utilities[0] + gp - 1) === minimumBufferS and Vp * (utilities[max] + gp - 1) === bufferTarget
        // giving:
        const gp = (utilities[highestUtilityIndex] - 1) / (bufferTime / MINIMUM_BUFFER_S - 1);
        const Vp = MINIMUM_BUFFER_S / gp;
        return {gp: gp, Vp: Vp};
        // note that expressions for gp and Vp assume utilities[0] === 1, which is true because of normalization
        }
     

    function getInitialL2AState(rulesContext) {
        const initialState = {};
        const mediaInfo = rulesContext.getMediaInfo();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        let utilities = utilitiesFromBitrates(bitrates);
        utilities = utilities.map(u => u - utilities[0] + 1); // normalize
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        const params = calculateL2AParameters(stableBufferTime, bitrates, utilities);

        if (!params) {
            // only happens when there is only one bitrate level
            initialState.state = L2A_STATE_ONE_BITRATE;
        } else {
            initialState.state = L2A_STATE_STARTUP;

            initialState.bitrates = bitrates;
            initialState.utilities = utilities;
            initialState.stableBufferTime = stableBufferTime;
            initialState.Vp = params.Vp;
            initialState.gp = params.gp;

            initialState.lastQuality = 0;
            clearL2AStateOnSeek(initialState);
        }

        return initialState;
    }

    function clearL2AStateOnSeek(L2AState) {
        L2AState.placeholderBuffer = 0;
        L2AState.mostAdvancedSegmentStart = NaN;
        L2AState.lastSegmentWasReplacement = false;
        L2AState.lastSegmentStart = NaN;
        L2AState.lastSegmentDurationS = NaN;
        L2AState.lastSegmentRequestTimeMs = NaN;
        L2AState.lastSegmentFinishTimeMs = NaN;
    }

    // If the buffer target is changed (can this happen mid-stream?), then adjust L2A parameters accordingly.
    function checkL2AStateStableBufferTime(L2AState, mediaType) {
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        if (L2AState.stableBufferTime !== stableBufferTime) {
            const params = calculateL2AParameters(stableBufferTime, L2AState.bitrates, L2AState.utilities);
            if (params.Vp !== L2AState.Vp || params.gp !== L2AState.gp) {
                // correct placeholder buffer using two criteria:
                // 1. do not change effective buffer level at effectiveBufferLevel === MINIMUM_BUFFER_S ( === Vp * gp )
                // 2. scale placeholder buffer by Vp subject to offset indicated in 1.

                const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType, true);
                let effectiveBufferLevel = bufferLevel + L2AState.placeholderBuffer;

                effectiveBufferLevel -= MINIMUM_BUFFER_S;
                effectiveBufferLevel *= params.Vp / L2AState.Vp;
                effectiveBufferLevel += MINIMUM_BUFFER_S;

                L2AState.stableBufferTime = stableBufferTime;
                L2AState.Vp = params.Vp;
                L2AState.gp = params.gp;
                L2AState.placeholderBuffer = Math.max(0, effectiveBufferLevel - bufferLevel);
            }
        }
    }

    function getL2AState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let L2AState = L2AStateDict[mediaType];
        if (!L2AState) {
            L2AState = getInitialL2AState(rulesContext);
            L2AStateDict[mediaType] = L2AState;
        } else if (L2AState.state !== L2A_STATE_ONE_BITRATE) {
            checkL2AStateStableBufferTime(L2AState, mediaType);
        }
        return L2AState;
    }

    // The core idea of L2A.
    function getQualityFromBufferLevel(L2AState, bufferLevel) {
        const bitrateCount = L2AState.bitrates.length;
        let quality = NaN;
        let score = NaN;
        for (let i = 0; i < bitrateCount; ++i) {
            let s = (L2AState.Vp * (L2AState.utilities[i] + L2AState.gp) - bufferLevel) / L2AState.bitrates[i];
            if (isNaN(score) || s >= score) {
                score = s;
                quality = i;
            }
        }
        return quality;
    }

    // maximum buffer level which prefers to download at quality rather than wait
    function maxBufferLevelForQuality(L2AState, quality) {
        return L2AState.Vp * (L2AState.utilities[quality] + L2AState.gp);
    }

    // the minimum buffer level that would cause L2A to choose quality rather than a lower bitrate
    function minBufferLevelForQuality(L2AState, quality) {
        const qBitrate = L2AState.bitrates[quality];
        const qUtility = L2AState.utilities[quality];

        let min = 0;
        for (let i = quality - 1; i >= 0; --i) {
            // for each bitrate less than bitrates[quality], L2A should prefer quality (unless other bitrate has higher utility)
            if (L2AState.utilities[i] < L2AState.utilities[quality]) {
                const iBitrate = L2AState.bitrates[i];
                const iUtility = L2AState.utilities[i];

                const level = L2AState.Vp * (L2AState.gp + (qBitrate * iUtility - iBitrate * qUtility) / (qBitrate - iBitrate));
                min = Math.max(min, level); // we want min to be small but at least level(i) for all i
            }
        }
        return min;
    }

    /*
     * The placeholder buffer increases the effective buffer that is used to calculate the bitrate.
     * There are two main reasons we might want to increase the placeholder buffer:
     *
     * 1. When a segment finishes downloading, we would expect to get a call on getMaxIndex() regarding the quality for
     *    the next segment. However, there might be a delay before the next call. E.g. when streaming live content, the
     *    next segment might not be available yet. If the call to getMaxIndex() does happens after a delay, we don't
     *    want the delay to change the L2A decision - we only want to factor download time to decide on bitrate level.
     *
     * 2. It is possible to get a call to getMaxIndex() without having a segment download. The buffer target in dash.js
     *    is different for top-quality segments and lower-quality segments. If getMaxIndex() returns a lower-than-top
     *    quality, then the buffer controller might decide not to download a segment. When dash.js is ready for the next
     *    segment, getMaxIndex() will be called again. We don't want this extra delay to factor in the bitrate decision.
     */
    function updatePlaceholderBuffer(L2AState, mediaType) {
        const nowMs = Date.now();

        if (!isNaN(L2AState.lastSegmentFinishTimeMs)) {
            // compensate for non-bandwidth-derived delays, e.g., live streaming availability, buffer controller
            const delay = 0.001 * (nowMs - L2AState.lastSegmentFinishTimeMs);
            L2AState.placeholderBuffer += Math.max(0, delay);
        } else if (!isNaN(L2AState.lastCallTimeMs)) {
            // no download after last call, compensate for delay between calls
            const delay = 0.001 * (nowMs - L2AState.lastCallTimeMs);
            L2AState.placeholderBuffer += Math.max(0, delay);
        }

        L2AState.lastCallTimeMs = nowMs;
        L2AState.lastSegmentStart = NaN;
        L2AState.lastSegmentRequestTimeMs = NaN;
        L2AState.lastSegmentFinishTimeMs = NaN;

        checkL2AStateStableBufferTime(L2AState, mediaType);
    }

    function onBufferEmpty() {
        // if we rebuffer, we don't want the placeholder buffer to artificially raise L2A quality
        for (const mediaType in L2AStateDict) {
            if (L2AStateDict.hasOwnProperty(mediaType) && L2AStateDict[mediaType].state === L2A_STATE_STEADY) {
                L2AStateDict[mediaType].placeholderBuffer = 0;
            }
        }
    }

    function onPlaybackSeeking() {
        // TODO: 1. Verify what happens if we seek mid-fragment.
        // TODO: 2. If e.g. we have 10s fragments and seek, we might want to download the first fragment at a lower quality to restart playback quickly.
        for (const mediaType in L2AStateDict) {
            if (L2AStateDict.hasOwnProperty(mediaType)) {
                const L2AState = L2AStateDict[mediaType];
                if (L2AState.state !== L2A_STATE_ONE_BITRATE) {
                    L2AState.state = L2A_STATE_STARTUP; // TODO: L2A_STATE_SEEK?
                    clearL2AStateOnSeek(L2AState);
                }
            }
        }
    }

    function onPeriodSwitchStarted() {
        // TODO: does this have to be handled here?
    }

    function onMediaFragmentLoaded(e) {
        if (e && e.chunk && e.chunk.mediaInfo) {
            const L2AState = L2AStateDict[e.chunk.mediaInfo.type];
            if (L2AState && L2AState.state !== L2A_STATE_ONE_BITRATE) {
                const start = e.chunk.start;
                if (isNaN(L2AState.mostAdvancedSegmentStart) || start > L2AState.mostAdvancedSegmentStart) {
                    L2AState.mostAdvancedSegmentStart = start;
                    L2AState.lastSegmentWasReplacement = false;
                } else {
                    L2AState.lastSegmentWasReplacement = true;
                }

                L2AState.lastSegmentStart = start;
                L2AState.lastSegmentDurationS = e.chunk.duration;
                L2AState.lastQuality = e.chunk.quality;

                checkNewSegment(L2AState, e.chunk.mediaInfo.type);
            }
        }
    }

    function onMetricAdded(e) {
        if (e && e.metric === MetricsConstants.HTTP_REQUEST && e.value && e.value.type === HTTPRequest.MEDIA_SEGMENT_TYPE && e.value.trace && e.value.trace.length) {
            const L2AState = L2AStateDict[e.mediaType];
            if (L2AState && L2AState.state !== L2A_STATE_ONE_BITRATE) {
                L2AState.lastSegmentRequestTimeMs = e.value.trequest.getTime();
                L2AState.lastSegmentFinishTimeMs = e.value._tfinish.getTime();

                checkNewSegment(L2AState, e.mediaType);
            }
        }
    }

    /*
     * When a new segment is downloaded, we get two notifications: onMediaFragmentLoaded() and onMetricAdded(). It is
     * possible that the quality for the downloaded segment was lower (not higher) than the quality indicated by L2A.
     * This might happen because of other rules such as the DroppedFramesRule. When this happens, we trim the
     * placeholder buffer to make L2A more stable. This mechanism also avoids inflating the buffer when L2A itself
     * decides not to increase the quality to avoid oscillations.
     *
     * We should also check for replacement segments (fast switching). In this case, a segment is downloaded but does
     * not grow the actual buffer. Fast switching might cause the buffer to deplete, causing L2A to drop the bitrate.
     * We avoid this by growing the placeholder buffer.
     */
    function checkNewSegment(L2AState, mediaType) {
        if (!isNaN(L2AState.lastSegmentStart) && !isNaN(L2AState.lastSegmentRequestTimeMs) && !isNaN(L2AState.placeholderBuffer)) {
            L2AState.placeholderBuffer *= PLACEHOLDER_BUFFER_DECAY;

            // Find what maximum buffer corresponding to last segment was, and ensure placeholder is not relatively larger.
            if (!isNaN(L2AState.lastSegmentFinishTimeMs)) {
                const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType, true);
                const bufferAtLastSegmentRequest = bufferLevel + 0.001 * (L2AState.lastSegmentFinishTimeMs - L2AState.lastSegmentRequestTimeMs); // estimate
                const maxEffectiveBufferForLastSegment = maxBufferLevelForQuality(L2AState, L2AState.lastQuality);
                const maxPlaceholderBuffer = Math.max(0, maxEffectiveBufferForLastSegment - bufferAtLastSegmentRequest);
                L2AState.placeholderBuffer = Math.min(maxPlaceholderBuffer, L2AState.placeholderBuffer);
            }

            // then see if we should grow placeholder buffer

            if (L2AState.lastSegmentWasReplacement && !isNaN(L2AState.lastSegmentDurationS)) {
                // compensate for segments that were downloaded but did not grow the buffer
                L2AState.placeholderBuffer += L2AState.lastSegmentDurationS;
            }
            segment_request_start_s=0.001*L2AState.lastSegmentRequestTimeMs;
            segment_download_finish_s=0.001*L2AState.lastSegmentFinishTimeMs;
            L2AState.lastSegmentStart = NaN;
            L2AState.lastSegmentRequestTimeMs = NaN;
        }
    }

    function onQualityChangeRequested(e) {
        // Useful to store change requests when abandoning a download.
        if (e) {
            const L2AState = L2AStateDict[e.mediaType];
            if (L2AState && L2AState.state !== L2A_STATE_ONE_BITRATE) {
                L2AState.abrQuality = e.newQuality;
            }
        }
    }

    function onFragmentLoadingAbandoned(e) {
        if (e) {
            const L2AState = L2AStateDict[e.mediaType];
            if (L2AState && L2AState.state !== L2A_STATE_ONE_BITRATE) {
                // deflate placeholderBuffer - note that we want to be conservative when abandoning
                const bufferLevel = dashMetrics.getCurrentBufferLevel(e.mediaType, true);
                let wantEffectiveBufferLevel;
                if (L2AState.abrQuality > 0) {
                    // deflate to point where L2A just chooses newQuality over newQuality-1
                    wantEffectiveBufferLevel = minBufferLevelForQuality(L2AState, L2AState.abrQuality);
                } else {
                    wantEffectiveBufferLevel = MINIMUM_BUFFER_S;
                }
                const maxPlaceholderBuffer = Math.max(0, wantEffectiveBufferLevel - bufferLevel);
                L2AState.placeholderBuffer = Math.min(L2AState.placeholderBuffer, maxPlaceholderBuffer);
            }
        }
    }

   function indexOfMin(arr) {
       if (arr.length === 0) {
           return -1;
       }
   
       var min = arr[0];
       var minIndex = 0;
   
       for (var i = 0; i < arr.length; i++) {
           if (arr[i] <= min) {
               minIndex = i;
               min = arr[i];
           }
       }
   
       return minIndex;
   } 

   function indexofMax(arr) {
    if (arr.length === 0) {
        return -1;
    }

    var max = arr[0];
    var maxIndex = 0;

    for (var i = 0; i < arr.length; i++) {
        if (arr[i] >= max) {
            maxIndex = i;
            max = arr[i];
        }
    }

    return maxIndex;
} 

   function dotmultiplication(arr1,arr2) {
       if (arr1.length != arr2.length) {
           return -1;
       }
   
       var sumdot =0;
   
       for (var i = 0; i < arr1.length; i++) {
           sumdot=sumdot+arr1[i]*arr2[i];
       }
   
       return sumdot;
   } 
   
   function Euclidean_projection(arr)
   {

    //project an n-dim vector y to the simplex Dn
    // Dn = { x : x n-dim, 1 >= x >= 0, sum(x) = 1}

    //Algorithm is explained at http://arxiv.org/abs/1101.6081
          const m = arr.length
          var bget = false;
          var arr2=[];
          for (let ii = 0; ii < m; ++ii) {
         arr2[ii]=arr[ii];
       }
           var s =arr.sort(function(a, b){return b-a}); 
           var tmpsum = 0;
           var tmax = 0;
           var x=[];
           
           
           for (let ii = 0; ii < m-1; ++ii) {
           
               tmpsum = tmpsum + s[ii];
               
               tmax = (tmpsum - 1)/(ii+1);
              
               if (tmax >= s[ii+1]){
               
                   bget = true;
                   break;
               } 
                
           }
  
       if (!bget){
           tmax = (tmpsum + s[m-1] -1)/m;
       }
       for (let ii = 0; ii < m; ++ii) {
        x[ii] = Math.max(arr2[ii]-tmax,0);
       }
       return x;
   }

    function getMaxIndex(rulesContext) {
        const switchRequest = SwitchRequest(context).create();
        const horizon=5;
        const VL = Math.pow(horizon,0.5);
        const alpha =Math.max(Math.pow(horizon,1),VL*Math.sqrt(horizon));
        let diff1=[];
        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        const bitrateCount = bitrates.length;
        const scheduleController = rulesContext.getScheduleController();
        const streamInfo = rulesContext.getStreamInfo();
        const abrController = rulesContext.getAbrController();
        const throughputHistory = abrController.getThroughputHistory();
        const streamId = streamInfo ? streamInfo.id : null;
        const isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        const useL2AABR = rulesContext.useL2AABR();
        const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType, true);
        const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        const safeThroughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);
        const latency = throughputHistory.getAverageLatency(mediaType);
        let quality;
        let qualityL2A;


        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') ||
            !rulesContext.hasOwnProperty('getScheduleController') || !rulesContext.hasOwnProperty('getStreamInfo') ||
            !rulesContext.hasOwnProperty('getAbrController') || !rulesContext.hasOwnProperty('useL2AABR')) {
                console.log(!rulesContext.hasOwnProperty('useL2AABR'))
            return switchRequest;
        }

        switchRequest.reason = switchRequest.reason || {};

        if (!useL2AABR) {
            return switchRequest;
        }

        scheduleController.setTimeToLoadDelay(0);

        const L2AState = getL2AState(rulesContext);

        if (L2AState.state === L2A_STATE_ONE_BITRATE) {
            // shouldn't even have been called
            return switchRequest;
        }

        switchRequest.reason.state = L2AState.state;
        switchRequest.reason.throughput = throughput;
        switchRequest.reason.latency = latency;

        if (isNaN(throughput)) { // isNaN(throughput) === isNaN(safeThroughput) === isNaN(latency)
            // still starting up - not enough information
            return switchRequest;
        }

        switch (L2AState.state) {
            case L2A_STATE_STARTUP:
                quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, latency);

                switchRequest.quality = quality;
                switchRequest.reason.throughput = safeThroughput;

                L2AState.placeholderBuffer = Math.max(0, minBufferLevelForQuality(L2AState, quality) - bufferLevel);
                L2AState.lastQuality = quality;

                if (!isNaN(L2AState.lastSegmentDurationS) && bufferLevel >= L2AState.lastSegmentDurationS) {
                    L2AState.state = L2A_STATE_STEADY;
                }

                break; // L2A_STATE_STARTUP

            case L2A_STATE_STEADY:


                /////////////////////////////////////////////////////////

                //General comments: 1. Figure out scales of a)buffer (s) and b) bitrates (bps) and throughput (kbps) DONE
                //                   2. Initialization of Q1, Q2 w and prev_w (currently hard coded).
                //                   3. Verify initialization for alpha and VL
                //                   4. Implement true previous throughput let c_throughput=V*(bitrates[prevQuality])/(1000*(segment_download_finish_s-segment_request_start_s));
                const V=L2AState.lastSegmentDurationS;
                console.log('Segment duration:',L2AState.lastSegmentDurationS)
                console.log('Download duration:', segment_download_finish_s-segment_request_start_s) 

                //console.log('Computed throughput:',c_throughput);
                console.log('VL:',VL);        
                console.log('Alpha:',alpha);        
                let c_throughput=throughput/1000;
                //console.log('Buffer level');        
                //console.log(bufferLevel); 
                //console.log('Bitrates');        
                //console.log(bitrates);
                if (w.length==0){
                    Q1=0;
                   // Q2=0;
                    for (let i = 0; i < bitrateCount; ++i) {
                    if (i==0){
                            w[i]=0.33;
                            prev_w[i]=0.33
                            prev_w2[i]=0.33;
                            sum_w[i]=0;
                        }
                        else{
                            w[i]=0.33;
                            prev_w[i]=0.33;
                            prev_w2[i]=0.33;
                            sum_w[i]=0;   
                        }
                    }
                } 
              
                
                    for (let i = 0; i < bitrateCount; ++i) {
                        bitrates[i]=bitrates[i]/(1000*1000);   
                        sum_w[i]=sum_w[i]+(bitrates[i]/Math.min(2*bitrates[bitrateCount-1],c_throughput))*(VL-V*Q1);
                        w[i]=prev_w[i]-(1/(2*alpha))*sum_w[i];             
                        sum_w[i]=0; //(bitrates[i]/(2*alpha))*(-VL+((Q1-Q2)*V)/Math.min(2*bitrates[bitrateCount-1],c_throughput));//-Q2
                        diff1[i]=w[i]-prev_w[i];
                        prev_w2[i]=Math.abs(w[i]);
                    }                        
                     
                    //for (let i = 0; i < bitrateCount; ++i) {
                     //        bitrates[i]=bitrates[i]/(1000*1000);   
                        //      sum_w[i]=sum_w[i]+(bitrates[i]/Math.min(2*bitrates[bitrateCount-1],c_throughput))*(-VL+Q1);
                       //      w[i]=prev_w[i]-(1/(2*alpha))*(-VL*bitrates[i]-Q1*V*bitrates[i]/Math.min(2*bitrates[bitrateCount-1],c_throughput));             
                         //     sum_w[i]=0; //(bitrates[i]/(2*alpha))*(-VL+((Q1-Q2)*V)/Math.min(2*bitrates[bitrateCount-1],c_throughput));//-Q2
                         //    diff1[i]=w[i]-prev_w[i];
                   // }
              
                
                console.log('w pre-proj:',w);
                    
                w=Euclidean_projection(w);
                
                console.log('w post-proj:',w);        
            
                console.log('Throughput:',c_throughput);        

                    
                console.log('Q1 pre-update:',Q1);        

               // console.log('Q2 pre-update:',Q2);        
               if(dotmultiplication(bitrates,prev_w)<c_throughput){
                    Q1=Math.max(0,Q1+V-V*dotmultiplication(prev_w,bitrates)/Math.min(2*bitrates[bitrateCount-1],c_throughput)-B_target/horizon-V*dotmultiplication(bitrates,diff1)/Math.min(2*bitrates[bitrateCount-1],c_throughput));
                }
                else{
                    Q1=0;//Math.max(0,Q1+V-V*dotmultiplication(prev_w,bitrates)/Math.min(2*bitrates[bitrateCount-1],c_throughput)-B_target-3*dotmultiplication(bitrates,prev_w)/Math.min(2*bitrates[bitrateCount-1],c_throughput)-V*dotmultiplication(bitrates,diff1)/Math.min(2*bitrates[bitrateCount-1],c_throughput));//Math.max(0,Q1+dotmultiplication(prev_w,bitrates)+dotmultiplication(bitrates,diff1)-throughput);
                }
            // Q2=Math.max(0,Q2+V*dotmultiplication(prev_w,bitrates)/Math.min(2*bitrates[bitrateCount-1],c_throughput)-(V+B_target)+V*dotmultiplication(bitrates,diff1)/Math.min(2*bitrates[bitrateCount-1],c_throughput));
               // Q1=Math.max(0,Q1+V-V*dotmultiplication(prev_w,bitrates)/Math.min(2*bitrates[bitrateCount-1],c_throughput)-B_target/horizon-V*dotmultiplication(bitrates,diff1)/Math.min(2*bitrates[bitrateCount-1],c_throughput));//Math.max(0,Q1+dotmultiplication(prev_w,bitrates)+dotmultiplication(bitrates,diff1)-throughput);
                //Q2=Math.max(0,Q2+V-(V/c_throughput)*(dotmultiplication(prev_w,bitrates)+dotmultiplication(bitrates,diff1))-B_target/horizon);//might need to add buffer level (check constraint)

                console.log('Q1 post-update:',Q1);        
                //console.log('Q2 post-update:',Q2);        

                let temp=[];
            
                for (let i = 0; i < bitrateCount; ++i) {
                    prev_w[i]=w[i];            
                    temp[i]=Math.abs(bitrates[i]-dotmultiplication(w,bitrates));  
                }
                console.log('Verification of argmin:',bitrates, dotmultiplication(w,bitrates))
                qualityL2A = indexOfMin(temp);//indexofMax(w);
               // if (prevqualityL2A!=qualityL2A){switches=switches+1;}
                prevqualityL2A=qualityL2A;
                console.log('Quality L2A:',qualityL2A);        
                        
                ////////////////////////////////////////////////////  

                // NB: The placeholder buffer is added to bufferLevel to come up with a bitrate.
                //     This might lead L2A to be too optimistic and to choose a bitrate that would lead to rebuffering -
                //     if the real buffer bufferLevel runs out, the placeholder buffer cannot prevent rebuffering.
                //     However, the InsufficientBufferRule takes care of this scenario.

                updatePlaceholderBuffer(L2AState, mediaType);

                quality = getQualityFromBufferLevel(L2AState, bufferLevel + L2AState.placeholderBuffer);

                // we want to avoid oscillations
                // We implement the "L2A-O" variant: when network bandwidth lies between two encoded bitrate levels, stick to the lowest level.
                const qualityForThroughput = abrController.getQualityForBitrate(mediaInfo, safeThroughput, latency);
                if (quality > L2AState.lastQuality && quality > qualityForThroughput) {
                    // only intervene if we are trying to *increase* quality to an *unsustainable* level
                    // we are only avoid oscillations - do not drop below last quality

                    quality = Math.max(qualityForThroughput, L2AState.lastQuality);
                }

                // We do not want to overfill buffer with low quality chunks.
                // Note that there will be no delay if buffer level is below MINIMUM_BUFFER_S, probably even with some margin higher than MINIMUM_BUFFER_S.
                let delayS = Math.max(0, bufferLevel + L2AState.placeholderBuffer - maxBufferLevelForQuality(L2AState, quality));

                // First reduce placeholder buffer, then tell schedule controller to pause.
                if (delayS <= L2AState.placeholderBuffer) {
                    L2AState.placeholderBuffer -= delayS;
                    delayS = 0;
                } else {
                    delayS -= L2AState.placeholderBuffer;
                    L2AState.placeholderBuffer = 0;

                    if (quality < abrController.getTopQualityIndexFor(mediaType, streamId)) {
                        // At top quality, allow schedule controller to decide how far to fill buffer.
                        scheduleController.setTimeToLoadDelay(1000 * delayS);
                    } else {
                        delayS = 0;
                    }
                }
                quality=qualityL2A;
                switchRequest.quality = quality;       
                switchRequest.reason.throughput = throughput;
                switchRequest.reason.latency = latency;
                switchRequest.reason.bufferLevel = bufferLevel;
                switchRequest.reason.placeholderBuffer = L2AState.placeholderBuffer;
                switchRequest.reason.delay = delayS;

                L2AState.lastQuality = quality;
                // keep L2AState.state === L2A_STATE_STEADY

                break; // L2A_STATE_STEADY

            default:
                logger.debug('L2A ABR rule invoked in bad state.');
                // should not arrive here, try to recover
                switchRequest.quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, latency);
                switchRequest.reason.state = L2AState.state;
                switchRequest.reason.throughput = safeThroughput;
                switchRequest.reason.latency = latency;
                L2AState.state = L2A_STATE_STARTUP;
                clearL2AStateOnSeek(L2AState);
        }
        console.log('Quality BOLA:',switchRequest.quality); 
        counter=counter+1;
        console.log('Segment counter:',counter)  

        return switchRequest;
    }

    function resetInitialSettings() {
        L2AStateDict = {};
    }

    function reset() {
        resetInitialSettings();

        eventBus.off(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.off(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
        eventBus.off(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
        eventBus.off(Events.METRIC_ADDED, onMetricAdded, instance);
        eventBus.off(Events.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        eventBus.off(Events.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);
    }

    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();
    return instance;
}

L2ARule.__dashjs_factory_name = 'L2ARule';
export default FactoryMaker.getClassFactory(L2ARule);
