<template>
    <div class="container">
        <input type="file" @change="handleFileChange" :disabled="uploadStatus !== STATUS.wait" />
        <div class="operation">
            <el-button @click="handleUpload" :disabled="uploadDisabled" type="primary">
                开始上传
            </el-button>
            <el-button v-if="uploadStatus === STATUS.pause" @click="handleResume" type="primary"
                >继续</el-button
            >
            <el-button
                v-else
                :disabled="uploadStatus !== STATUS.uploading"
                @click="handlePause"
                type="primary"
                >暂停</el-button
            >
            <el-button @click="handleDelete" type="primary">删除已上传的所有文件</el-button>
        </div>
        <div class="totalPercentage">
            <div>上传总进度：</div>
            <div class="progress"><el-progress :percentage="uploadPercentage"></el-progress></div>
        </div>
        <el-table :data="fileObj.chunkList" row-key="hash">
            <el-table-column prop="hash" label="分片hash" align="center"></el-table-column>
            <el-table-column label="分片大小(KB)" align="center" width="120">
                <template v-slot="{ row }">
                    {{ transformByte(row.size) }}
                </template>
            </el-table-column>
            <el-table-column label="上传进度" align="center">
                <template v-slot="{ row }">
                    <el-progress :percentage="row.percentage"></el-progress>
                </template>
            </el-table-column>
        </el-table>
    </div>
</template>

<script setup>
    import { reactive, ref, computed } from 'vue';
    import { request } from '@/utils/request.js';
    import { transformByte } from '@/utils/index.js';
    import STATUS from '@/enums/status.js';

    const uploadStatus = ref(STATUS.wait);
    const singleChunkSize = 10 * 1024 * 1024; //10 MB
    const fileObj = reactive({
        file: null,
        hash: null,
        chunkList: [], //分片列表
    });
    const chunkRequestList = ref([]); //分片xhr上传实例，方便vue-devtools捕捉使用ref包裹。
    const uploadDisabled = computed(() => {
        return !fileObj.file || [STATUS.pause, STATUS.uploading].includes(uploadStatus.value);
    });
    //上传文件的总进度
    const uploadPercentage = computed(() => {
        if (!fileObj.file || !fileObj.chunkList.length) return 0;
        const loaded = fileObj.chunkList
            .map((item) => item.size * item.percentage)
            .reduce((acc, cur) => acc + cur);
        return parseInt((loaded / fileObj.file.size).toFixed(2));
    });

    const handleFileChange = (e) => {
        const [file] = e.target.files;
        if (!file) return;
        resetData();
        fileObj.file = file;
    };

    const handleUpload = async () => {
        if (!fileObj.file) {
            return ElMessage({
                message: '请选择要上传的文件',
                type: 'warning',
            });
        }

        uploadStatus.value = STATUS.uploading;
        const fileChunkList = createFileChunk(fileObj.file, singleChunkSize);
        fileObj.hash = await calculateHash(fileChunkList);

        //通过文件hash值请求服务端文件是否已上传成功，未上传成功时会返回已上传完毕的文件切片，没有则是空数组
        const { shouldUpload, uploadedList } = await verifyUpload(fileObj.file.name, fileObj.hash);

        //服务端有该文件，文件已上传成功过
        if (!shouldUpload) {
            ElMessage({
                message: '上传成功',
                type: 'success',
            });
            uploadStatus.value = STATUS.wait;
            return;
        }

        //需要上传
        fileObj.chunkList = fileChunkList.map(({ file }, index) => {
            const hash = fileObj.hash + '-' + index;
            const isUploaded = uploadedList.includes(hash);
            return {
                fileHash: fileObj.hash,
                index,
                hash,
                chunk: file,
                size: file.size,
                percentage: isUploaded ? 100 : 0,
            };
        });

        //开始上传需要上传的分片
        uploadChunks(uploadedList);
    };

    // 生成文件切片
    const createFileChunk = (file, sigleSize) => {
        const fileChunkList = [];
        let cur = 0;
        while (cur < file.size) {
            fileChunkList.push({ file: file.slice(cur, cur + sigleSize) });
            cur += sigleSize;
        }
        return fileChunkList;
    };

    let calculateHashWorker = null;
    // 生成文件 hash，计算量大，会影响主线程（特别是ui渲染），使用web worker创建其他线程进行计算。
    const calculateHash = (fileChunkList) => {
        return new Promise((resolve) => {
            const loadingPopup = ElLoading.service({
                lock: true,
                fullscreen: true,
                text: '上传准备中...（此时正在计算文件hash） 进度：0%',
                background: 'rgba(0, 0, 0, 0.7)',
            });
            calculateHashWorker = new Worker(
                new URL('./worker/calculateHash.js', import.meta.url),
                { type: 'module' }
            );
            calculateHashWorker.postMessage({ fileChunkList });
            calculateHashWorker.onmessage = (e) => {
                const { percentage, hash } = e.data;
                loadingPopup.setText(
                    `上传准备中...（此时正在计算文件hash） 进度${Number(percentage.toFixed(2))}%`
                );
                if (hash) {
                    resolve(hash);
                    loadingPopup.close();
                }
            };
        });
    };

    // 根据 hash 验证文件是否曾经已经被上传过
    const verifyUpload = (filename, fileHash) => {
        return request({
            url: 'http://localhost:3000/verify',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            data: JSON.stringify({
                filename,
                fileHash,
            }),
        }).then((res) => {
            return JSON.parse(res.data);
        });
    };

    // 上传切片，同时过滤已上传的切片
    const uploadChunks = async (uploadedList = []) => {
        const requestList = fileObj.chunkList
            .filter(({ hash }) => !uploadedList.includes(hash))
            .map(({ chunk, hash, index }) => {
                const formData = new FormData();
                formData.append('chunk', chunk);
                formData.append('hash', hash);
                formData.append('filename', fileObj.file.name);
                formData.append('fileHash', fileObj.hash);
                return { formData, index };
            })
            .map(({ formData, index }) =>
                request({
                    url: 'http://localhost:3000',
                    method: 'POST',
                    data: formData,
                    onProgress: createProgressHandler.bind(null, fileObj.chunkList[index]),
                    requestList: chunkRequestList.value,
                })
            );
        Promise.all(requestList)
            .then(() => {
                //全部上传成功，通知服务端合并切片
                noticeMergeRequest();
            })
            .catch(() => {
                //有切片上传失败，失败的切片请求保存在 chunkRequestList.value中
                ElMessage({
                    message: '上传失败',
                    type: 'error',
                });
                console.log(chunkRequestList.value);
            });
    };

    // 设置每个 chunk 的上传进度数据,e为xhr onProgress的回调参数
    const createProgressHandler = (chunk, e) => {
        chunk.percentage = parseInt(String((e.loaded / e.total) * 100));
    };

    // 通知服务端合并切片
    const noticeMergeRequest = async () => {
        request({
            url: 'http://localhost:3000/merge',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
            },
            data: JSON.stringify({
                size: singleChunkSize,
                fileHash: fileObj.hash,
                filename: fileObj.file.name,
            }),
        }).then(() => {
            ElMessage({
                message: '上传成功',
                type: 'success',
            });
            uploadStatus.value = STATUS.wait;
        });
    };

    //暂停
    const handlePause = () => {
        uploadStatus.value = STATUS.pause;
        resetData();
    };

    const resetData = () => {
        chunkRequestList.value.forEach((xhr) => xhr?.abort());
        chunkRequestList.value = [];
        if (calculateHashWorker) {
            calculateHashWorker.onmessage = null;
        }
    };

    //继续，从服务端获取改文件上传状态以及上传成功的切片，重新上传需要的分片
    const handleResume = async () => {
        uploadStatus.value = STATUS.uploading;
        const { shouldUpload, uploadedList } = await verifyUpload(fileObj.file.name, fileObj.hash);
        //此时shouldUpload必定为true
        uploadChunks(uploadedList);
    };

    //删除所有已经上传的文件（方便调试）
    const handleDelete = async () => {
        request({
            url: 'http://localhost:3000/delete',
            method: 'POST',
        }).then(({ data }) => {
            if (JSON.parse(data).code === 0) {
                ElMessage({
                    message: '删除成功',
                    type: 'success',
                });
            }
        });
    };
</script>

<style scoped>
    .container {
        margin: 20px auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 20px 10px;
        width: 1000px;
        border: 1px solid rgb(0, 140, 255);
    }

    .operation {
        padding: 20px 0;
    }

    .totalPercentage {
        display: flex;
        align-items: center;
        padding-bottom: 10px;
        width: 100%;
    }

    .totalPercentage .progress {
        flex: 1;
    }
</style>
