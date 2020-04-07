If you have any questions, or would like help setting up the test env, please file an issue or reach out to theo@unified-streaming.com

# Assets for ACM MMSys 2020 Grand Challenge on Near Second Latency Bitrate Adaptation 

This repo contains assets for ACM MMSys 2020 Grand Challenge, [Adaptation Algorithm for Near-Second Latency](https://2020.acmmmsys.org/lll_challenge.php). It contains everything you need to build and test low-latency ABR algorithms locally.

## What's in the Box

- A fork of [Dash.js v3.0.1](https://github.com/Dash-Industry-Forum/dash.js), modified to pre-request low-latency segments
- NEW -> An implementation of a bitrate adapataion algorithm based on Online Convex Optimization called Learn2Adapt-LowLatancy (L2A-LL). The implementation can be accessed at  ⁨`dash.js⁩/src⁩/⁨streaming⁩/⁨rules⁩/⁨abr/L2ARule.js`, while to run the implemented algorithm one needs to execute ⁩ '`dash.js⁩/samples⁩/low-latency⁩/index.html`
- A low-latency [DASH server](https://gitlab.com/fflabs/dash_server), setup and configured for ease of use
- ffmpeg for MacOS built from the dashll branch (https://gitlab.com/fflabs/ffmpeg/tree/dashll) at commit 0fe5e13b9b76e7fac0c2dac1f4fdc8b37c007d13


## Requirements
- MacOS
    - If you're using another operating system, don't worry. You'll just have to build ffmpeg from source, and change a few variables. See that README in dash-ll-server/ for instructions.
- python3
- node.js v12+
- Chrome (latest, v80 at the moment)


## How to use

- Install each project locally by by following their enclosed README (of the  dash.js folder)
- Start Dash.js by running `grunt dev` in the `dash.js` folder
- In a separate terminal window, start the ingest server by running `bash run_server.sh` in the `dash-ll-server` folder.
- Important -> A test video sequence needs to be downloaded seperately and added in the `dash-ll-server` folder
1. Download the test stream located [here](http://distribution.bbb3d.renderfarming.net/video/mp4/bbb_sunflower_1080p_30fps_normal.mp4).
2. Move the test stream to this folder. Rename the stream to "bbb.mp4".
3. Start the server in a terminal with `bash run_server.sh`
4. In a separate terminal, start ffmpeg with `bash run_gen.sh`
5. The DASH manifest will be located at http://localhost:9001/live/live.mpd

From here you have a few options:
### Executing test runs
This option should be used for validating your solution against our network patterns.

- Execute the following command: `npm run test`
    - If your computer isn't fast enough, see the "Help!" section below
- When the test run has concluded, end the program in the same shell (cmd+c on mac, ctrl+c on windows)
- Tests results are written to the results/ folder

Note: The python server (`bash run_server.sh` step above) and the dash server (`grunt dev` step above) must be running to execute these tests!
This will kick off an automated test, during which network conditions will be emulated. At the end of the run the statistics will be logged. We'll be adding new test runs throughout the challenge.

#### Configuring Test Runs
There are several network profiles which can be tested against. In order to set a profile, change the `network_profile` option within the `config` block in the `package.json`. The following profiles are currently available:
    - PROFILE_CASCADE
    - PROFILE_INTRA_CASCADE
    - PROFILE_SPIKE
    - PROFILE_SLOW_JITTERS
    - PROFILE_FAST_JITTERS
