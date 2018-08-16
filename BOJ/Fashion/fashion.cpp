 // https://www.acmicpc.net/problem/9375
// 18-08-16 19:45 ~ 21:35

#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <string.h>



int main() {
	int T, N, cnt,nCat;
	char cat[30][21];
	int nItem[30] = {0};
	char tmpcat[21],tmpname[21];
	
	scanf("%d", &T);
	for (int t = 0; t < T; t++) {
		//init
		nCat = 0;
		memset(nItem, 0x00, sizeof(int) * 30);
		scanf("%d", &N);
		for (int i = 0; i < N; i++) {
			// GET INPUT
			scanf("%s", tmpname);
			scanf("%s", tmpcat);
			for (int j = 0; j <= nCat; j++) {
				if (strcmp(cat[j], tmpcat) == 0) { // already added
					nItem[j] ++;
					break;
				}
				else if (j == nCat) {
					nItem[nCat] += 1;
					strcpy(cat[nCat++], tmpcat);
					break;
				}
			}
		}
		cnt = 1;
		for (int i = 0; i < nCat; i++) {
			cnt *= nItem[i] + 1;
		}
		cnt -= 1;
		printf("%d\n", cnt);
	}

#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}