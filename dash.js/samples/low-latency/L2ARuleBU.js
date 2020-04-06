/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
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

//import ListSegmentsGetter from '../../src/dash/utils/ListSegmentsGetter.js';
//import Segment from '../../src/dash/vo/Segment.js';
import MetricsConstants from '../../src/streaming/constants/MetricsConstants.js';
import SwitchRequest from '../../src/streaming/rules/SwitchRequest.js';
import FactoryMaker from '../../src/core/FactoryMaker.js';
import { HTTPRequest } from '../../src/streaming/vo/metrics/HTTPRequest.js';
import EventBus from '../../src/core/EventBus.js';
import Events from '../../src/core/events/Events.js';
import Debug from '../../src/core/Debug.js';


const L2A_STATE_ONE_BITRATE    = 0;
const L2A_STATE_STARTUP        = 1;
const L2A_STATE_STEADY         = 2;
let w = [];
let prev_w = [];
let Q1=0;
let Q2=0;
let prev_Q1=0;
let prev_Q2=0;
let B_target=3;

function L2ARule(config) {
    //console.log(config);
    config = config || {};
    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let MetricsModel = factory.getSingletonFactoryByName('MetricsModel');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    let context = this.context;  
    const dashMetrics = config.dashMetrics;   
    const mediaPlayerModel = config.mediaPlayerModel;
    const eventBus = EventBus(context).getInstance();
    
    let instance,
        logger,
        L2AStateDict;

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        resetInitialSettings();
        console.log('1');
        console.log(Events.PLAYBACK_SEEKING); 
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        
        eventBus.on(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.on(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
        eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
        eventBus.on(Events.METRIC_ADDED, onMetricAdded, instance);
        eventBus.on(Events.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        eventBus.on(Events.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);
    
    }
    function resetInitialSettings() {
        L2AStateDict = {};
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
    */

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

    function calculateL2AParameters() {
         //6. Horizon (total number of segments). Here we may choose an artificial value (live)
        const horizon=1000;
        const VL = Math.pow(horizon,0.9);
        const alpha =Math.max(Math.pow(horizon,1),VL*Math.sqrt(horizon));
        return {alpha: alpha, VL: VL};
    }


    function indexOfMin(arr) {
        if (arr.length === 0) {
            return -1;
        }
    
        var min = arr[0];
        var minIndex = 0;
    
        for (var i = 1; i < arr.length; i++) {
            if (arr[i] < min) {
                minIndex = i;
                min = arr[i];
            }
        }
    
        return minIndex;
    } 
    function dotmultiplication(arr1,arr2) {
        if (arr1.length != arr2.length) {
            return -1;
        }
    
        var sumdot =0;
    
        for (var i = 1; i < arr1.length; i++) {
            sumdot=sumdot+arr1[i]*arr2[i];
        }
    
        return sumdot;
    } 
    
    function Euclidean_projection(arr)
    {
       /* function x = projsplx(y)
        % project an n-dim vector y to the simplex Dn
        % Dn = { x : x n-dim, 1 >= x >= 0, sum(x) = 1}
    
        % Algorithm is explained as in the linked document
        % http://arxiv.org/abs/1101.6081*/
     
           const m = arr.length // m=length(y); 
           var bget = false;
            var s =arr.sort(function(a, b){return b-a}); //s=sort(y,'descend'); 
            var tmpsum = 0;
            var tmax = 0;
            var x=[];
            
            for (let ii = 0; ii < m; ++ii) {
            
                tmpsum = tmpsum + s[ii];
                tmax = (tmpsum - 1)/ii;
                if (tmax >= s[ii+1]){
                    bget = true;
                }
            }
    
        if (!bget){
            tmax = (tmpsum + s[m] -1)/m;
        }
        for (let ii = 0; ii < m; ++ii) {
         x[ii] = Math.max(arr[ii]-tmax,0);
        }
        return x;
    }

    // Always use lowest bitrate
    function getMaxIndex(rulesContext) {
        // here you can get some informations aboit metrics for example, to implement the rule
        const params = calculateL2AParameters();
        let metricsModel = MetricsModel(context).getInstance();
        var mediaType = rulesContext.getMediaInfo().type;
        var metrics = metricsModel.getMetricsFor(mediaType, true);
        var dashMetrics = player.getDashMetrics();
        //let switchRequest = SwitchRequest(context).create();
        // A smarter (real) rule could need analyze playback metrics to take
        // bitrate switching decision. Printing metrics here as a reference
        //console.log(metrics);
        const streamInfo = rulesContext.getStreamInfo();
        //console.log(streamInfo);
        var isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        

        // Get current bitrate
       // const abrController = rulesContext.getAbrController();
        
        let streamController = StreamController(context).getInstance();
        let abrController = rulesContext.getAbrController();
        let current = abrController.getQualityFor(mediaType, streamController.getActiveStreamInfo());
        const throughputHistory = abrController.getThroughputHistory();

        // If already in lowest bitrate, don't do anything
        if (current === 0) {
            return SwitchRequest(context).create();
        }
        
       
        const mediaInfo = rulesContext.getMediaInfo();
        const bitrates = mediaInfo.bitrateList.map(b => b.bandwidth);
        const bitrateCount = bitrates.length;
       // console.log(bitrates);
        var throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        //console.log(mediaType);
        //console.log(isDynamic)
        //console.log(throughput);
        var bufferLevel=dashMetrics.getCurrentBufferLevel(mediaType, true);
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        console.log(stableBufferTime);
        const V=2;
        //console.log(dashMetrics);
        //const safeThroughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);
        //const latency = throughputHistory.getAverageLatency(mediaType);
       // let quality;
       
        // console.log(bitrates);
        //console.log(bufferLevel);
        //console.log(throughput);
        //console.log(safeThroughput);
        //console.log(latency);
        
        
        // main L2A logic
        //Missing:
 
        //1. Segment duration (Check function onMediaFragmentLoaded(e) above
        //2. Implement Eucledian_projection function
        //3. Implement calculateL2AParameters funciton
        //4. Debug
        
        for (let i = 0; i < bitrateCount; ++i) {
            w[i]=prev_w[i]-(bitrates[i]/2*params.alpha)*(-params.VL+Q1-Q2*V/throughput)
            w[i]=Euclidean_projection(w);
            prev_w[i]=w[i]       
        }

        w=Euclidean_projection(w);
        
        for (let i = 0; i < bitrateCount; ++i) {
            prev_w[i]=w[i]       
        }
              
        Q1=Math.max(0,dotmultiplication(prev_w,bitrates)*throughput+dotmultiplication(bitrates,(w-prev_w)));
        Q2=Math.max(0,bufferLevel +V-V*dotmultiplication(prev_w,bitrates/throughput)-B_target+dotmultiplication((-V*bitrates/throughput),(w-prev_w)));
        
        prev_Q1=Q1;
        prev_Q2=Q2;
        
        let switchRequest = SwitchRequest(context).create();
        switchRequest.quality = indexOfMin(Math.abs(bitrates-dotmultiplication(w,bitrates))) ;// The lowest value of bitrates[i] such that the distance |bitrate[i]-dotmultiplication(w,R)| is minimized.


        //let switchRequest = SwitchRequest(context).create();
        //switchRequest.quality=0;
        console.log('In L2A');
        console.log(switchRequest.quality);

        switchRequest.reason = 'Always switching to the bitrate indicated by L2A';
        switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
        return switchRequest;
    }

    instance = {
        getMaxIndex: getMaxIndex
    };

    setup();

    return instance;
}

L2ARule.__dashjs_factory_name = 'L2ARule';
window.L2ARule = dashjs.FactoryMaker.getClassFactory(L2ARule);

