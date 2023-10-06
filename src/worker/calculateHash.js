import SparkMD5 from 'spark-md5';

// 及时返回文件hash生成进度，生成完毕会返回文件hash值
self.onmessage = e => {
    const { fileChunkList } = e.data;
    const spark = new SparkMD5.ArrayBuffer();
    let percentage = 0;
    let count = 0;
    const loadNext = index => {
        const reader = new FileReader();
        reader.readAsArrayBuffer(fileChunkList[index].file);
        reader.onload = e => {
            count++;
            spark.append(e.target.result);
            if (count === fileChunkList.length) {
                self.postMessage({
                    percentage: 100,
                    hash: spark.end()
                });
                self.close();
            } else {
                percentage += 100 / fileChunkList.length;
                self.postMessage({
                    percentage
                });
                loadNext(count);
            }
        };
    };
    loadNext(0);
};